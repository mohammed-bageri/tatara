# @tatara/auth

Part of [tatara](https://github.com/mohammed-bageri/tatara). The principal contract, guards,
OpenAPI merge, dev outbox and test helpers for better-auth.

## createAuthInstance

```ts
export const { auth, attachPrincipal, requireOrg, attachSession, requireSession, handleRequest } =
	createAuthInstance(betterAuthOptions, {
		resolvers: [keycloakResolver], // other credentials besides the session, tried in order
		org: "platform", // every principal of this instance acts in this org (e.g. staff)
		// better-auth reads the client IP only from `header`, which handleRequest sets from `resolve`
		// after dropping any client-sent copy; nothing resolved → "0.0.0.0" (one shared bucket)
		clientIp: { header: "x-app-client-ip", resolve: (c) => clientIp(c, { trustedHops: 1 }) },
		onUnauthorized: (c) => c.json({ code: "UNAUTHORIZED" }, 401), // requireSession's answer
	});

app.on(["GET", "POST"], "/api/auth/*", (c) => handleRequest(c));
app.use(attachSession); // c.var.session / c.var.user, as better-auth returns them
app.get("/me", requireSession, handler); // 401 without a user, or while the admin plugin's ban holds
```

`attachPrincipal` / `requireAuth()` / `requireOrg()` are the principal-based alternative to
`attachSession` / `requireSession`. Type the session variables with
`SessionEnv<typeof auth.$Infer.Session>`. Two instances (tenant and staff) differ only in their
better-auth options (`basePath`, `advanced.cookiePrefix`, plugins) and `org`.
