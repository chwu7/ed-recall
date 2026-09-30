import { join } from 'node:path';
import { atomicWrite, readJson } from './files.mjs';
import { writeThread } from './archive.mjs';
export async function syncCourses({ client, dir, courses, index, onProgress = () => {} }) {
  const path = join(dir, 'sync.json');
  const state = await readJson(path, { version: 1, courses: {} });
  const report = { fetched: 0, changed: 0, resumed: 0, failures: [], warnings: [] };
  const save = () => atomicWrite(path, JSON.stringify(state, null, 2) + '\n');
  for (const course of courses) {
    let run = state.courses[course.id];
    if (!run || run.complete) run = { startedAt: new Date().toISOString(), complete: false, completed: [], lastSuccessAt: run?.lastSuccessAt ?? null };
    else report.resumed += run.completed.length;
    state.courses[course.id] = run; run.error = null; await save();
    try {
      // Re-enumeration avoids restoring an offset into a moving list after interruption.
      let previous = null, ids = [];
      for (let pass = 0; pass < 3; pass++) {
        ids = [];
        for await (const key of client.threads(course.id)) ids.push(key);
        ids.sort((a, b) => Number(a) - Number(b));
        if (previous && JSON.stringify(previous) === JSON.stringify(ids)) break;
        if (pass === 2) throw new Error('Course listing kept changing; rerun sync to finish enumeration.');
        previous = ids;
      }
      const completed = new Set(run.completed);
      let failed = false;
      for (const key of ids) {
        if (completed.has(key)) continue;
        try {
          const thread = await client.thread(key);
          if (thread.courseId !== course.id) throw new Error('Thread course does not match selected course.');
          const written = await writeThread(dir, thread, course);
          index.update(written.archive);
          report.fetched++; if (written.changed) report.changed++;
          for (const warning of written.warnings) report.warnings.push({ threadId: key, warning });
          completed.add(key); run.completed = [...completed]; await save();
          onProgress(`${course.code}: thread ${key} (${completed.size}/${ids.length})`);
        } catch (e) {
          if (e.status === 401 || e.status === 429) throw e;
          failed = true; report.failures.push({ courseId: course.id, threadId: key, message: e.message });
        }
      }
      run.complete = !failed; run.lastAttemptAt = new Date().toISOString();
      if (run.complete) { run.lastSuccessAt = run.lastAttemptAt; run.completed = []; }
      else run.error = 'Some threads failed; rerun sync to resume.';
    } catch (e) {
      run.error = e.message; report.failures.push({ courseId: course.id, message: e.message });
      await save();
      if (e.status === 401 || e.status === 429) break;
    }
    await save();
  }
  return report;
}
export async function syncStatus(dir, selectedCourses, maxAgeHours = 24) {
  const state = await readJson(join(dir, 'sync.json'), { courses: {} });
  const tracked = selectedCourses.length ? selectedCourses : Object.keys(state.courses);
  const courses = tracked.map(id => {
    const info = state.courses[id];
    const stale = !info?.complete || !info.lastSuccessAt || Date.now() - Date.parse(info.startedAt) > maxAgeHours * 3600000;
    return { id, lastSuccessAt: info?.lastSuccessAt ?? null, startedAt: info?.startedAt ?? null, incomplete: !info?.complete, needsSync: stale, error: info?.error ?? null };
  });
  return { needsSync: !courses.length || courses.some(c => c.needsSync), maxAgeHours, courses };
}
