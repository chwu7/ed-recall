import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWrite, readJson } from './files.mjs';
import { writeThread } from './archive.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const needsRefresh = (info, maxAgeHours) => {
  const startedAt = Date.parse(info?.startedAt);
  return !info?.complete || !info.lastSuccessAt || !Number.isFinite(startedAt) || Date.now() - startedAt > maxAgeHours * 3600000;
};
const failure = (course, error, threadId) => ({ courseId: course.id, ...(threadId ? { threadId } : {}),
  message: error.message, status: error.status ?? 0, retryable: Boolean(error.retryable) && error.status !== 401 && error.status !== 429 });

export async function syncCourses({ client, dir, courses, index, onProgress = () => {}, resumeOnly = false, refresh = false, maxAgeHours = 24, maxRetries = 1, sleep = pause }) {
  const path = join(dir, 'sync.json');
  const state = await readJson(path, { version: 1, courses: {} });
  const pending = new Set(state.pendingCourses ?? courses.filter(c => state.courses[c.id]?.complete === false).map(c => c.id));
  const resuming = resumeOnly || courses.some(c => pending.has(c.id));
  const work = courses.filter(c => refresh || (resuming ? !state.courses[c.id]?.complete : needsRefresh(state.courses[c.id], maxAgeHours)));
  const report = { fetched: 0, changed: 0, resumed: 0, retries: 0,
    skippedCourses: courses.filter(c => !work.includes(c)).map(c => c.id), failures: [], warnings: [] };
  const save = () => atomicWrite(path, JSON.stringify(state, null, 2) + '\n');
  // Mark every course in the batch unfinished before fetching. Even courses not yet
  // reached must remain pending if the process is killed midway through a refresh.
  for (const course of work) {
    pending.add(course.id);
    let run = state.courses[course.id];
    if (!run || run.complete || refresh) run = { startedAt: new Date().toISOString(), complete: false, completed: [],
      lastSuccessAt: run?.lastSuccessAt ?? null, coverageWarnings: [], warningCount: 0 };
    else report.resumed += run.completed.length;
    run.coverageWarnings ??= []; run.warningCount ??= 0;
    state.courses[course.id] = run;
  }
  state.pendingCourses = [...pending]; await save();
  let halt = false;
  for (const course of work) {
    const run = state.courses[course.id];
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      run.error = null; run.failures = []; await save();
      try {
        // Re-enumerate instead of restoring an offset into a moving list.
        let previous = null, ids = [];
        for (let pass = 0; pass < 3; pass++) {
          ids = [];
          for await (const key of client.threads(course.id)) ids.push(key);
          ids.sort((a, b) => Number(a) - Number(b));
          if (previous && JSON.stringify(previous) === JSON.stringify(ids)) break;
          if (pass === 2) throw new Error('Course listing kept changing; rerun sync to finish enumeration.');
          previous = ids;
        }
        run.totalThreads = ids.length;
        const listed = new Set(ids), completed = new Set(run.completed.filter(key => listed.has(key)));
        run.coverageWarnings = run.coverageWarnings.filter(w => listed.has(w.threadId));
        run.completed = [...completed]; run.completedThreads = completed.size; await save();
        for (const key of ids) {
          if (completed.has(key)) continue;
          try {
            const thread = await client.thread(key);
            if (thread.courseId !== course.id) throw new Error('Thread course does not match selected course.');
            const written = await writeThread(dir, thread, course);
            index.update(written.archive);
            report.fetched++; if (written.changed) report.changed++;
            for (const warning of written.warnings) report.warnings.push({ threadId: key, warning });
            run.warningCount += written.warnings.length;
            run.coverageWarnings = run.coverageWarnings.filter(w => w.threadId !== key);
            for (const warning of thread.warnings ?? []) run.coverageWarnings.push({ threadId: key, warning });
            completed.add(key); run.completed = [...completed]; run.completedThreads = completed.size; await save();
            onProgress(`${course.code}: thread ${key} (${completed.size}/${ids.length})`);
          } catch (error) {
            run.failures.push(failure(course, error, key)); await save();
            onProgress(`${course.code}: thread ${key} failed: ${error.message}`);
            if (error.status === 401 || error.status === 429) { halt = true; break; }
          }
        }
      } catch (error) {
        run.failures.push(failure(course, error));
        if (error.status === 401 || error.status === 429) halt = true;
      }
      run.complete = !run.failures.length; run.lastAttemptAt = new Date().toISOString();
      if (run.complete) {
        run.lastSuccessAt = run.lastAttemptAt; run.completed = [];
        pending.delete(course.id); state.pendingCourses = [...pending];
      } else run.error = 'Some threads failed; run sync --resume to retry. See failures for details.';
      await save();
      if (run.complete || halt || !run.failures.some(f => f.retryable) || attempt === maxRetries) break;
      report.retries++;
      onProgress(`${course.code}: retrying unfinished work from checkpoints (${attempt + 1}/${maxRetries})`);
      await sleep(1000 * 2 ** attempt);
    }
    report.failures.push(...run.failures);
    if (halt) break;
  }
  return report;
}
export async function syncStatus(dir, selectedCourses, maxAgeHours = 24) {
  const state = await readJson(join(dir, 'sync.json'), { courses: {} });
  const tracked = selectedCourses.length ? selectedCourses : Object.keys(state.courses);
  const courses = tracked.map(id => {
    const info = state.courses[id];
    // Use the start of the snapshot: a long resume may include old checkpointed content.
    const stale = needsRefresh(info, maxAgeHours);
    return { id, lastSuccessAt: info?.lastSuccessAt ?? null, startedAt: info?.startedAt ?? null, incomplete: !info?.complete,
      needsSync: stale, error: info?.error ?? null,
      completedThreads: info?.completedThreads ?? (info?.complete ? null : info?.completed?.length ?? 0),
      totalThreads: info?.totalThreads ?? null, failures: info?.failures ?? [],
      coverageUncertain: Boolean(info?.coverageWarnings?.length), warnings: info?.coverageWarnings ?? [] };
  });
  let syncRunning = false;
  try {
    const pid = Number(await readFile(join(dir, 'writer.lock'), 'utf8'));
    // Local retrieval also takes the writer lock; do not report our own read as a running sync.
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try { process.kill(pid, 0); syncRunning = true; } catch (error) { if (error.code !== 'ESRCH') syncRunning = true; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { needsSync: !courses.length || courses.some(c => c.needsSync), syncRunning,
    coverageUncertain: courses.some(c => c.coverageUncertain), maxAgeHours, courses };
}
