# Implementing CivitAI OAuth: a field guide

A portable, application-agnostic guide to connecting any application to CivitAI
with OAuth 2.0. Written after implementing it end to end, so it front-loads the
things that are not in CivitAI's documentation and that cost the most time to
discover.

**Provenance.** Everything marked **VERIFIED** was measured against the live
service on **2026-08-04** by running the flow and inspecting real responses.
Items marked *reported* come from a separate working implementation but were not
re-measured. Items marked *inferred* are reasoning, not observation. CivitAI's
platform is actively changing — re-verify before trusting any of this in
production, and prefer writing a throwaway probe over believing this document.

---

## 0. Read this first: the four things that will cost you a day

1. **`scope` is a mandatory integer bitmask, not a space-delimited string.**
   Omitting it does *not* fall back to your app's registered permissions — it
   fails with `invalid_scope`. Most published bit values do not exist anywhere
   official.
2. **OAuth tokens work on tRPC but are rejected by the public REST v1 API.**
   `/api/v1/*` returns `401` for a valid OAuth token. If your application needs
   REST v1, you must keep an API key alongside OAuth. This is the single most
   consequential design constraint.
3. **tRPC responses are mid-migration between two serialization formats**, and
   different endpoints are at different stages. A naive parser silently returns
   *zero results* instead of erroring — it looks exactly like an empty account.
4. **NSFW content only appears on `civitai.red`.** The same authenticated query
   against `civitai.com` returns zero items. This is a content filter, not an
   auth failure, and it will look like a permissions bug.

---

## 1. The OAuth server

**VERIFIED.** CivitAI runs a standard OAuth 2.0 Authorization Code + PKCE server
on a dedicated host, separate from the main site:

```
https://auth.civitai.com/api/auth/oauth/authorize
https://auth.civitai.com/api/auth/oauth/token
https://auth.civitai.com/api/auth/oauth/userinfo
```

- PKCE method: **S256** (SHA-256, base64url, unpadded)
- Access token lifetime: **3600 seconds**
- Token type: `Bearer`
- Refresh: supported, and **rotates the refresh token** on every use
- Public clients receive **no client secret** and none is sent to `/token`
- An unauthenticated `GET` on `/authorize` returns **303** to
  `/login?returnUrl=...`, which is normal, not a redirect-URI rejection

---

## 2. Registering the application

CivitAI account settings → **OAuth Applications** → **Register App**.

### App type

Choose **Browser / Mobile App** (`public`) for desktop, mobile, and SPA clients.
CivitAI's own copy lists "React/Vue SPAs, iOS, Android, desktop apps" under this
type. It uses PKCE and issues no secret.

Choose **Server App** (`confidential`) *only* if your code runs on a backend you
control. A client secret inside a distributed binary is not a secret — decompile
or `strings` will find it.

### Redirect URIs

One per line, matched **exactly** — no trailing-slash or port flexibility.

| Client type | Redirect URI | Status |
| --- | --- | --- |
| Desktop | `http://127.0.0.1:8765/callback` | **VERIFIED accepted** |
| Mobile | `com.example.app://oauth/callback` | *reported working* |
| Web | `https://example.com/auth/callback` | not tested here |

The loopback form (RFC 8252) is the correct pattern for desktop. Because the
match is exact, **the port cannot be dynamic** — you cannot bind port 0 and use
whatever you get. Pick a port, register it, and handle the "port busy" case with
a clear error rather than a silent fallback.

Note a documentation conflict: CivitAI's written guidance says production
redirects should be HTTPS, while its registration validator and OAuth server
accept loopback and custom schemes for public clients. Treat this as a release
risk to re-verify, not a settled question.

### Permissions

The registration screen presents a Read/Write/Delete grid over these resources:

```
Profile & Settings   Read  Write   —
Models               Read  Write  Delete
Media & Posts        Read  Write  Delete
Articles             Read  Write  Delete
Bounties             Read  Write  Delete
AI Services          Read  Write   —
Buzz                 Read   —      —
Collections          Read  Write   —
Social                —    Write   —
Notifications        Read  Write   —
Vault                Read  Write   —
```

Grant the minimum. In particular, **do not grant Delete** unless you genuinely
delete things — but be aware of the consequence in §3.

---

## 3. Scope: the bitmask

**VERIFIED.** `scope` is a **decimal integer bitmask** passed as a query
parameter. It is **mandatory**. Omitting it returns:

```json
{"error":"invalid_scope","error_description":"Invalid scope value"}
```

The server will **not** substitute the permissions you registered the app with.
Your client must always send an explicit value.

### Known bit values

| Bit | Permission | Confidence |
| ---: | --- | --- |
| 1 | Profile & Settings Read | **VERIFIED** |
| 4 | Models Read | *reported* |
| 32 | Media & Posts Read | **VERIFIED** |
| 64 | Media & Posts Write | **VERIFIED** (granted; `post.create` then succeeded) |
| 131072 | Collections Read | **VERIFIED** |
| 262144 | Collections Write | *reported* |
| 524288 | Social Write | *reported* |
| 2097152 | Notifications Read | *reported* |
| 4194304 | Notifications Write | *reported* |

Every other bit — Articles, Bounties, AI Services, Buzz, Vault, and all Delete
permissions — is **unpublished**. Do not guess: a sequential reconstruction of
the grid does *not* reproduce the known values (there is an unexplained gap
between Social Write at bit 19 and Notifications Read at bit 21), so the layout
is not a simple 3-bits-per-resource packing.

**To discover an unknown bit:** request a candidate value and read the granted
`scope` back off the token response. The consent screen also enumerates the
permissions in human-readable form, so requesting a wide mask and *reading the
screen* (you may then cancel) tells you what exists.

### Common combinations

```
131105  = 1 | 32 | 131072          read identity, media, collections
131169  = 1 | 32 | 64 | 131072     the above plus creating posts
```

The granted scope comes back in the token response and, when your request is
satisfiable, equals what you asked for verbatim.

### The Delete trap

**VERIFIED.** Write and Delete are separate permissions. If you grant Write but
not Delete, you can create a post but **cannot delete it** — `post.delete`
returns `403`. Any test that creates content will therefore strand it on a real
account. Either request Delete for test builds, or accept manual cleanup, but
decide before you run the test, not after.

---

## 4. The flow

Standard Authorization Code + PKCE. Nothing exotic.

### Authorization request

```
GET https://auth.civitai.com/api/auth/oauth/authorize
  ?client_id=<public client id>
  &redirect_uri=http://127.0.0.1:8765/callback
  &response_type=code
  &scope=131169
  &state=<random, base64url>
  &code_challenge=<base64url(sha256(verifier))>
  &code_challenge_method=S256
```

The verifier is 43–128 characters; base64url of 32 random bytes gives 43.

### Token exchange

`POST` to `/token`, `application/x-www-form-urlencoded`, **no client secret and
no Basic auth header**:

```
grant_type=authorization_code
code=<from callback>
redirect_uri=<byte-identical to the authorize request>
client_id=<public client id>
code_verifier=<the original verifier>
```

Response:

```json
{
  "access_token": "...", "refresh_token": "...",
  "expires_in": 3600, "token_type": "Bearer", "scope": 131169
}
```

Parse `scope` defensively — integer is what you get today, but string and
single-element-array forms have been observed elsewhere in the platform.

### Refresh

```
grant_type=refresh_token
refresh_token=<current>
client_id=<public client id>
```

**VERIFIED: the refresh token is rotated.** Two consequences that break naive
implementations:

- **Persist the new refresh token on every renewal.** If your write fails or you
  keep the old value, the session dies at the *next* renewal, not this one —
  which makes it look intermittent and unrelated.
- **Serialize refreshes.** Two concurrent refreshes each rotate the other's
  token into invalidity. Use a mutex/semaphore around the whole
  read-check-refresh-write sequence.

Treat a `4xx` on refresh as terminal: clear the session and require sign-in.
Retrying cannot help.

### Identity

`GET /userinfo` with `Authorization: Bearer <token>` returns the account id and
username. This is the clean way to learn who is signed in — much better than
inferring it from content queries.

---

## 5. THE critical finding: tRPC yes, REST v1 no

**VERIFIED, on both `civitai.com` and `civitai.red`.**

| Surface | OAuth Bearer token | API key |
| --- | --- | --- |
| `https://civitai.com/api/trpc/*` | **works** | works |
| `https://civitai.com/api/v1/*` | **401 rejected** | works |

This is counterintuitive — the *public documented* API is the one that refuses
OAuth, while the *internal* tRPC API accepts it. Verified working over tRPC with
an OAuth token:

- `collection.getAllUser` — the user's collections (owned and followed)
- `collection.getById` — collection metadata
- `image.getInfinite` — paged images, including by `collectionId`
- `image.getGenerationData` — prompts, resources, generation parameters
- `post.create` — with scope bit 64

**Design consequence:** if your application touches REST v1 at all, OAuth is an
*addition*, not a replacement. Hold both credentials and select per endpoint
family:

```
tRPC     → OAuth token, falling back to API key, then cookies
REST v1  → API key only, then cookies
```

Memoize rejections **per (family, credential)**, not per family, or one 401 will
blacklist a credential that works elsewhere.

---

## 6. Calling tRPC without getting silently empty results

Three independent traps. All three produce *plausible-looking empty results*
rather than errors, which is what makes them expensive.

### 6a. Request shape

Input is a JSON object, URL-encoded into an `input` query parameter:

```
GET https://civitai.com/api/trpc/collection.getById?input=%7B%22json%22%3A%7B%22id%22%3A123%7D%7D
```

which is `{"json":{"id":123}}` encoded. Mutations `POST` the same envelope as a
body.

### 6b. Required browser-like headers

**VERIFIED.** Authenticated tRPC endpoints enforce an origin check. Without
matching `Referer` and `Origin`, requests are rejected with `401` *even with a
valid token* — this is the single most misdiagnosed CivitAI failure, because it
presents as "expired credentials".

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
Accept: application/json
Referer: https://civitai.red/      ← must match the host you are calling
Origin:  https://civitai.red
```

### 6c. Two response formats, and endpoints disagree

**VERIFIED.** CivitAI is migrating tRPC serialization. Both formats are live
simultaneously on different procedures:

**Legacy** — payload nested under `json`:

```json
{"result":{"data":{"json":{"items":[...],"nextCursor":42}}}}
```

**Current** — `result.data` is a **JSON-encoded string** containing a flat
*reference table*: an array where index 0 is the root and every integer value is
an index into the same array.

```json
{"result":{"data":"[{\"items\":1,\"nextCursor\":2},[3],42,{\"id\":4},7]"}}
```

Observed live: `collection.getAllUser` still returns legacy, while
`image.getInfinite` already returns the reference table. **A parser that only
handles the legacy shape returns `None`/`null` for the new one**, which callers
then read as zero items. There is no error, no status code, no warning.

Decoder (negative indices mean JavaScript-only values → null; memoize decoded
indices so shared references stay shared and cycles terminate):

```python
def decode_reference_table(value):
    if not isinstance(value, list) or not value:
        return value
    decoded = {}

    def decode(index):
        if index < 0:
            return None
        if index >= len(value):
            raise ValueError(f"reference {index} outside table")
        if index in decoded:
            return decoded[index]
        item = value[index]
        if isinstance(item, dict):
            result = {}
            decoded[index] = result          # before recursing, for cycles
            for key, ref in item.items():
                result[key] = decode(ref) if isinstance(ref, int) else ref
            return result
        if isinstance(item, list):
            result = []
            decoded[index] = result
            result.extend(decode(r) if isinstance(r, int) else r for r in item)
            return result
        decoded[index] = item
        return item

    return decode(0)


def extract_trpc_payload(body):
    """Handles both wire formats. Use for every tRPC response."""
    payload = body["result"]["data"]
    if isinstance(payload, str):
        return decode_reference_table(json.loads(payload))
    if isinstance(payload, dict) and "json" in payload:
        return payload["json"]
    return payload
```

---

## 7. The `.com` / `.red` split

**VERIFIED.** `civitai.red` is the adult-content mirror. The same authenticated
`image.getInfinite` call for the same collection returned **100 items with
`nsfwLevel` up to 16 on `.red`** and **0 items on `.com`**.

- Query `.red` for anything that might be NSFW.
- Send `browsingLevel: 31` to include all levels; `browsingLevel: 1` is PG only
  and will return zero for an adult collection.
- Match `Referer`/`Origin` to whichever host you are calling (§6b).
- The same OAuth token works on both hosts.

---

## 8. Platform notes

### Desktop: the loopback listener

**VERIFIED on Windows.** Use a **raw TCP listener**, not a high-level HTTP
server API:

- .NET's `HttpListener` requires a `netsh http add urlacl` reservation and
  throws **"Access is denied"** for non-elevated processes. `TcpListener` on
  `127.0.0.1` has no such requirement and was confirmed to bind unelevated.
- Speak minimal HTTP by hand: read the request line, parse the target, write a
  small `200` with `Content-Length` and `Connection: close`.

**Handle unrelated requests.** Browsers fire `GET /favicon.ico` at your port. A
loop that treats "a request was handled" as "the callback arrived" will abort
before the real redirect lands. Use a **wall-clock deadline** for the timeout and
keep serving until the path actually matches. This bug bit both implementations
written for this guide, in two different languages.

Also: bind the port *before* opening the browser, so a port conflict fails
immediately rather than after the user has already consented.

### Mobile

*Reported working:* custom-scheme redirect (`com.example.app://oauth/callback`),
authorization in a Custom Tab / `ASWebAuthenticationSession`, token exchange in
native code, tokens in Keystore/Keychain.

### Token storage

Encrypt at rest — DPAPI (Windows), Keystore (Android), Keychain (iOS), or the
platform secret service. Store the whole envelope together: access token,
refresh token, absolute expiry, granted scope, and identity.

Treat *undecryptable* as *signed out*, not as an error. Encrypted blobs do not
survive being copied between user accounts or machines, and a hard failure there
turns a minor inconvenience into a broken application.

### Passing tokens to a child process

Use **environment variables, never command-line arguments** — argument strings
land in logs, crash dumps, and process listings. Refresh immediately before
launch so the child gets close to a full hour, and let the child fall back to
another credential rather than fail if it outlives the token.

---

## 9. Sign-out

A public client cannot revoke a grant server-side — there is no secret with
which to authenticate a revocation call. Sign-out is **local**: delete the stored
session. Tell the user explicitly that revoking access on CivitAI's side is done
from **Account Settings → OAuth Applications**, or they will assume your button
did more than it did.

---

## 10. Recommended approach: probe before you build

The most efficient path is a **throwaway probe script** that runs the real flow
and hits the real endpoints your app needs, *before* writing application code.
Building the service first and debugging through the application means every
question costs a rebuild.

A good probe:

1. Pre-flights the authorize endpoint to check the redirect URI is accepted.
2. Runs the full interactive flow and prints the granted scope.
3. Calls **every endpoint family the application will use**, reporting
   `PASS`/`FAIL` with the HTTP status and one line of evidence each.
4. Tests refresh.
5. Prints a compact paste-able summary.

**Make the probe fail loudly rather than emptily.** When a call returns zero
results, report the response's top-level keys and payload type — that is what
distinguishes "auth is broken", "the filter excluded everything", and "your
parser returned null" (§6c). All three look identical otherwise.

**Include a control.** Run the same query with a *different* credential (cookies,
an API key, anonymous). When both fail identically, the fault is in your client,
not the credential — this single technique caught the reference-table parsing
bug in minutes after it had masqueraded as an OAuth permissions problem.

**Sanity-check your fixtures.** One "OAuth cannot read images" result turned out
to be a probe querying an *Article* collection with an *image* endpoint. Zero was
the correct answer to the wrong question. Verify the type of whatever you point
tests at.

---

## 11. Quick reference

```
Authorize   https://auth.civitai.com/api/auth/oauth/authorize
Token       https://auth.civitai.com/api/auth/oauth/token
UserInfo    https://auth.civitai.com/api/auth/oauth/userinfo
tRPC        https://civitai.com/api/trpc/<procedure>?input=<urlencoded json>
tRPC NSFW   https://civitai.red/api/trpc/<procedure>   (+ matching Referer/Origin)
REST v1     https://civitai.com/api/v1/*               (API key only — 401 for OAuth)

PKCE        S256, verifier = base64url(32 random bytes)
Scope       mandatory decimal bitmask; 131105 read, 131169 read + create posts
Lifetime    access 3600s; refresh token ROTATES on every use
Secret      none — public client
Sign-out    local only
```

### Failure decoder

| Symptom | Most likely cause |
| --- | --- |
| `invalid_scope` at authorize | `scope` missing, or a bit your app was not registered for |
| `401` on `/api/v1/*` with a good token | Expected — REST v1 rejects OAuth; use an API key |
| `401` on tRPC with a good token | Missing/mismatched `Referer` + `Origin` (§6b) |
| `200` but zero items, every query | Parser does not handle the reference-table format (§6c) |
| `200` but zero items, one collection | Wrong host (`.com` for NSFW) or `browsingLevel` too low (§7) |
| `403` on a delete | Delete is a separate permission from Write (§3) |
| Session dies after working once | Rotated refresh token not persisted (§4) |
| "Access is denied" binding the callback | `HttpListener` without urlacl — use a raw TCP listener (§8) |
| Sign-in hangs, never returns | Listener aborted on the browser's favicon request (§8) |
