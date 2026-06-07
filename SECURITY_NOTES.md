# Security Notes — TeleCloud

> Issues to revisit before any public/hosted deployment.

---

## 1. Stored XSS via innerHTML — `upload.html:281, 326, 359`
**Priority: Fix before going public**

File names from Telegram and folder names are injected directly into `innerHTML` without escaping. A crafted filename like `<img src=x onerror=alert(1)>` would execute JS in the browser.

**Affects:**
- `upload.html:326` — file card title (`file.name`)
- `upload.html:359` — folder card title (`f`)
- `upload.html:281` — preview modal header (`name`)

**Fix:** Replace `innerHTML` with `textContent` for all user/server-supplied strings.

---

## 2. Content-Disposition Filename Not Sanitized — `main.py:1146`
**Priority: Low (Werkzeug blocks the main attack)**

`message.file.name` from Telegram is embedded raw into the `Content-Disposition` header. CRLF injection is blocked by Werkzeug automatically, but the filename is still unescaped.

**Fix:** Sanitize filename before setting the header, e.g. strip non-printable/special chars.

---

## 3. Plaintext Fallback for Encrypted Credentials — `main.py:63-68`
**Priority: Low (requires filesystem access to exploit)**

If Fernet decryption of `api_sessions.json` or `user_folders.json` fails, the code silently falls back to reading the file as plaintext JSON.

**Fix:** Remove the plaintext fallback. If decryption fails, log an error and return `{}` — fail hard.

---

## 4. `phone_code_hashes` Not Scoped to Session — `main.py:141`
**Priority: Low (OTP still required to exploit)**

The OTP hash is stored in a global dict keyed only by phone number, not tied to any session or IP. An attacker who obtains the OTP from another source could complete login from any session.

**Fix:** Store the `phone_code_hash` in a short-lived server-side pre-auth token issued at `/send_code` and validated at `/verify_code`.

---

## Notes
- Issues 2, 3, 4 are low risk for local/personal use.
- Issue 1 (XSS) is the only one that matters if the app is ever hosted publicly.
- All four should be addressed before any public deployment.
