# API evidence and verification

This is a beta API adapter, not a specification of Ed's stable behavior.

## Sources reviewed on 2026-09-30

- [smartspot2/edapi API notes](https://github.com/smartspot2/edapi/blob/master/docs/api_docs.md): observed course/user/thread/comment shapes, recursive comment trees, and Ed XML tags. These are a third-party client's reverse-engineering notes.
- [smartspot2/edapi implementation](https://github.com/smartspot2/edapi/blob/master/edapi/edapi.py): `https://us.edstem.org/api/`, Bearer authentication, `/user`, `/courses/{id}/threads` with `limit`, `offset`, `sort=new`, and `/threads/{id}`.
- [EPFL Ed Discussion guide](https://www.epfl.ch/education/teaching/wp-content/uploads/2022/09/QUICKSTART_EdDiscussion.pdf): API-token setup, beta status, lack of a stable API guarantee, and inspecting actual requests for other routes.
- [Keyring binding documentation](https://github.com/Brooooooklyn/keyring-node): OS stores and the explicitly selected persistent Linux Secret Service backend.
- [Codex skill guidance](https://learn.chatgpt.com/docs/build-skills), [Pi skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md), [Claude Code skills](https://code.claude.com/docs/en/skills): invocation syntax, skill structure, and user installation locations.

The repository contains no real student data or recorded live Ed response. `test/fixtures/ed.mjs` constructs synthetic examples following those observations. Nothing here establishes that current Ed servers still use all these shapes.

## Implemented assumptions

| Capability | Handling | Verification |
| --- | --- | --- |
| Token | Bearer header on same-region HTTPS API GETs; no redirects | Source-reviewed and fixture-tested; live pending |
| Region | `https://{us,au,eu}.edstem.org/api/`; web URL uses `https://edstem.org/{region}/courses/{id}/discussion/{id}` | US source evidence; regional and web URL live checks pending |
| User/courses | `/user` returns `user.id` and `courses[].course` with `id`, `code`, `name` | Synthetic fixtures; live pending |
| Course list | `threads[]`; limit/offset pagination; stable enumeration; deduplicate IDs | Synthetic multipage/pinned fixtures; live pending |
| Thread detail | `thread` object, `users[]`, XML `content`, `answers[]`, recursive `comments[]` | Synthetic nested fixtures; live pending |
| Reply pagination | Observed documentation embeds replies. Also accept explicit `{items,next,total?}` collection envelopes and follow same-host URLs recursively | Defensive extension only; synthetic envelope tests **do not validate Ed's actual megathread pagination** |
| Truncation | Reject unsupported continuation markers, missing collections, cyclic/duplicate replies, and mismatched `reply_count` | Fixture-tested; count semantics need live confirmation |
| Incremental refresh | Re-fetch every thread on a new sync; skip committed work only while resuming an unfinished run | Local integration-tested; no reliance on reply timestamp propagation |
| Content conversion | Ed XML to Markdown; preserve unrecognized/invalid content as visible fenced XML | Local tests; live rich-content comparison pending |

Some beta shape changes can only be detected with live comparison (for example, an undocumented field that hides a continuation without a recognizable marker). The adapter cannot prove completeness for an unknown protocol. It deliberately errors on known indicators instead of substituting empty arrays. If Ed uses another continuation route, obtain a sanitized observed fixture and add that precise contract in `src/core/api.mjs`, with an integration test, before claiming support.

## Verification procedure

Follow the complete command sequence and comparison checklist in the [README](../README.md#manual-smoke-test-with-your-ed-account). Live verification must include a course with more than one listing page and a sufficiently large discussion to exercise any reply pagination. Do not equate success on a small thread with completeness for all threads.

The CLI has no live mutation routes. To test updates, add/edit replies manually only in a course where you are allowed to do so. Tests must not cause posts, messages, or notifications automatically.

Optional OS credential-store smoke check: run `ed-recall setup` with the hidden token prompt, close the terminal, open a fresh one without `EDSTEM_TOKEN`, and request `sync` through the installed agent skill. Then run `ed-recall logout`; another sync request should report that authentication is missing. Use `ed-recall.cmd` for these commands in Windows PowerShell. Repeat on each target OS before declaring that platform's persistent-storage integration verified. Backend unit tests use a mock entry and cannot establish real keychain availability.
