---
"@tatara/realtime": minor
---

`unsubscribeUser(channel, { orgId, userId, params })` takes one user's sockets in an org out of one channel, from the api process or any other (through Redis), and leaves their other subscriptions alone. A socket taken out of a channel this way can subscribe to it again without reconnecting.
