---
"@tatara/testing": minor
---

`deliverEvents({ events, drain })` runs every committed domain event's subscribers, and the events they emit in turn: it drains jobs, waits for post-commit publishes and relays until a round finds nothing.
