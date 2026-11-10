---
"@tatara/http": minor
---

Add optional `validation` parameter to `createRouter(options)` and `handleErrors(options)` to customize validation hook behavior. Allows configuring message format (`"generic"` or `"first-issue"`), status code, and detail shape. Defaults remain unchanged for backward compatibility.
