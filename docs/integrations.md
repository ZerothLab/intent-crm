# Models and delivery integrations

## Model connections

Intent supports DeepSeek and custom endpoints implementing the OpenAI-compatible Chat Completions protocol. DeepSeek uses `https://api.deepseek.com`; choose a model available to your provider account. The interface offers `deepseek-flash` as an editable starting value. Intent explicitly disables DeepSeek thinking mode for its bounded structured-response requests; it does not store or display provider reasoning traces. See [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/) for the provider controls. Consult the [DeepSeek API documentation](https://api-docs.deepseek.com/en/) for the current model catalog and provider limits.

For a custom service, enter its HTTPS API base URL, such as `https://models.example.com/v1`. Intent appends `/chat/completions` and sends a Bearer credential. The service must support `messages`, `model`, `stream: false`, `response_format: {"type":"json_object"}`, and `max_tokens`. Its response must contain a complete JSON string in `choices[0].message.content`, with `finish_reason: "stop"` when present. Intent validates the task-specific JSON schema and validates evidence references again before accepting business proposals. An HTTP success alone does not constitute a successful model test.

The deployment administrator must set the same `INTENT_ENCRYPTION_KEY` on API and worker services. Use a random 32-byte key encoded as canonical Base64, stored through your deployment secret manager. Provider credentials are encrypted with authenticated encryption and bound to their workspace and connection. API responses expose only whether a credential exists. Back up the encryption key separately from the database; losing it makes saved credentials unusable.

Set `INTENT_MODEL_ALLOWED_HOSTS` to a comma-separated list of exact custom hostnames. DeepSeek's official hostname is allowed by default. HTTPS, public DNS addresses, port 443, and URLs without embedded credentials, query strings, or fragments are required. Redirects are not followed, and the validated IP address is pinned for each request. Private network endpoints are intentionally unsupported by this connector. The current hostname allowlist is checked when saved connections are used. After updating the allowlist and restarting API and worker, removed custom hosts cannot receive new model requests.

Save a connection, test that exact revision, and then activate it for reasoning or extraction. Editing disables the connection and requires another test. Both purposes must have an active connection. Keep external credentials out of source files and browser storage. Changing the deployment encryption key requires re-entering all provider and delivery credentials; there is no automatic key-rotation job.

## Delivery gateway

Configure a gateway under **Delivery and runtime**. Set `INTENT_DELIVERY_ALLOWED_HOSTS` to the gateway's exact public hostname. Configure an HTTPS endpoint, sender address, Bearer credential, and a signing secret of at least 32 characters. The same HTTPS and network restrictions as model endpoints apply.

Intent sends one POST request for each approved operation:

```http
Authorization: Bearer <gateway credential>
Idempotency-Key: <operationId>
Content-Type: application/json
```

```json
{
  "operationId": "stable-operation-id",
  "revision": 2,
  "from": "sales@example.com",
  "to": "buyer@example.com",
  "subject": "Reviewed proposal",
  "text": "Approved message body"
}
```

The gateway must preserve idempotency for `operationId` and retain a searchable delivery ledger. Return the following only when delivery is confirmed according to your transport's documented semantics:

```json
{"status":"delivered","reference":"provider-delivery-reference"}
```

The response must contain exactly these two fields, and the trimmed reference must contain 3–200 characters. Extra fields, a blank or invalid reference, any other response, network failure, or timeout are treated as **unknown**. Intent does not automatically repeat the operation. An asynchronous gateway should send a signed delivery event when its outcome becomes known. Delivery means the transport's confirmed delivery outcome; it is not proof of reading or customer agreement.

Changing delivery settings invalidates pending execution approvals. Removing the gateway hostname from the deployment allowlist also blocks dispatch and returns affected approved actions to draft when execution checks the current policy; existing receipts and signed outcome callbacks remain available. Review the displayed mode before approving a draft. Simulated mode never sends customer messages.

## Signed inbound events

POST events to `/api/integrations/<workspaceId>/events`. Authentication uses that workspace's configured signing secret. Send these headers:

- `x-intent-timestamp`: Unix time in seconds, within five minutes of the server clock.
- `x-intent-signature`: lowercase hexadecimal HMAC-SHA256 of `timestamp + "." + rawRequestBody`, using the signing secret.

Sign the exact UTF-8 bytes sent; parsing and reserializing JSON changes the signature. Use a new timestamp and signature for a retried request, while retaining the event identifier and identical event content. Keep clocks synchronized.

A delivery event:

```json
{"eventId":"event-001","type":"delivery","operationId":"stable-operation-id","outcome":"delivered","reference":"provider-delivery-reference"}
```

A verified non-delivery event uses `"outcome":"not_delivered"`. It must mean that this operation did not deliver and cannot later deliver. Intent creates a fresh operation for any newly approved retry. Conflicting late delivery events remain in the audit history and require investigation.

A customer reply:

```json
{"eventId":"event-002","type":"reply","operationId":"stable-operation-id","sender":"buyer@example.com","title":"Proposal feedback","body":"Please revise the implementation schedule before we proceed."}
```

The sender must match the dispatched recipient. The reply becomes evidence linked to the customer and starts planning. The gateway is responsible for authenticating inbound email or channel identity before asserting the sender. Event and operation identifiers accept letters, digits, underscores, and hyphens, up to 100 characters.

Duplicate event identifiers with identical content return the original result. Reusing an identifier for different content is rejected. Keep the original event ID through retries, and retain your external references for reconciliation. Never resubmit an uncertain outbound operation as a new operation without first establishing non-delivery.
