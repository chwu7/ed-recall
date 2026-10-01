import { readFile } from 'node:fs/promises';
import { archiveFiles, parseArchive } from './archive.mjs';
import { syncStatus } from './sync.mjs';

const postedAt = thread => {
  const date = Date.parse(thread.createdAt);
  return Number.isFinite(date) ? date : -Infinity;
};
const newer = (candidate, previous) => !previous || postedAt(candidate) > postedAt(previous)
  || (postedAt(candidate) === postedAt(previous) && BigInt(candidate.id) > BigInt(previous.id));

// Read the Markdown source of record so listing works offline, during a sync,
// and before the search index has been created or rebuilt.
export async function listCourses(dir, selectedCourses, cachedCourses = []) {
  const freshness = await syncStatus(dir, selectedCourses);
  const summaries = new Map(freshness.courses.map(c => [c.id, { archivedThreads: 0, latestThread: null, course: null }]));
  const files = await archiveFiles(dir);
  for (const path of files) {
    const archive = parseArchive(await readFile(path, 'utf8'), path);
    const summary = summaries.get(archive.courseId);
    if (!summary) continue;
    summary.archivedThreads++;
    summary.course ??= archive.course;
    if (newer(archive, summary.latestThread)) {
      summary.latestThread = { id: archive.id, number: archive.number, title: archive.title,
        url: archive.url, createdAt: archive.createdAt, updatedAt: archive.updatedAt };
    }
  }
  const courses = freshness.courses.map(sync => {
    const summary = summaries.get(sync.id);
    const course = cachedCourses.find(c => c.id === sync.id) ?? summary.course ?? {};
    return { ...sync, code: course.code ?? sync.id, name: course.name ?? null,
      year: course.year ?? null, session: course.session ?? null, courseStatus: course.status ?? 'unknown',
      syncState: sync.incomplete ? (sync.startedAt || summary.archivedThreads ? 'incomplete' : 'not-synced')
        : sync.needsSync ? 'stale' : 'current', archivedThreads: summary.archivedThreads, latestThread: summary.latestThread };
  });
  return { ...freshness, archivedThreads: files.length,
    selectedArchivedThreads: courses.reduce((total, course) => total + course.archivedThreads, 0), courses };
}
