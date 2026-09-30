// Synthetic data shaped after smartspot2/edapi's documented responses.
// Explicit items/next pagination envelopes in tests are defensive, unverified shapes.
export const course = { id: '42', code: 'CS101', name: 'Introduction to Computing', year: '2026', session: 'Fall', status: 'active' };
export const userResponse = { user: { id: 7, name: 'Example Student' }, courses: [{ course: { ...course, id: 42 }, role: { role: 'student' } }] };
export const xml = text => `<document version="2.0"><paragraph>${text}</paragraph></document>`;
export const comment = (id, text, children = []) => ({ id, user_id: 9, content: xml(text), type: 'comment', created_at: '2026-09-01T12:00:00Z', updated_at: null, comments: children });
export function threadResponse(threadId = 100) {
  return { thread: { id: threadId, course_id: 42, number: threadId - 90, title: 'Late submissions policy', user_id: 7,
    created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z', content: xml('What is the policy for late submissions?'),
    reply_count: 3, answers: [{ ...comment(201, 'Staff allow late submissions within 48 hours.'), type: 'answer' }],
    comments: [comment(202, 'Does the policy apply to homework?', [comment(203, 'Yes, including the final homework.')])] },
    users: [{ id: 7, name: 'Example Student', course_role: 'student' }, { id: 9, name: 'Example Instructor', course_role: 'staff' }] };
}
