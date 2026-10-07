# Email templates

Pinboard's sign-in emails, in the Chart Room style. Paste each file's contents
into **Authentication → Email Templates** in the Supabase dashboard and set the
subject beside it:

| File | Template | Subject |
| --- | --- | --- |
| `magic-link.html` | Magic Link | `Your Pinboard sign-in link` |
| `confirm-signup.html` | Confirm signup | `Confirm your email for Pinboard` |

Both are needed. A person who already has an account gets the Magic Link email;
the first time an address is used — including someone invited from Board
settings who has never signed in — the link signs them up, which sends the
Confirm signup email instead.

Supabase fills in `{{ .ConfirmationURL }}`. Everything else is literal, so the
files open in a browser as-is for a rough preview; the URL simply won't work.

## House rules

- **No separate "you've been invited" email.** Invite links are ordinary
  sign-in links, so the same template is sent when you sign in yourself. The
  wording has to suit both, which is why it says nothing about who sent it.
- **Inline styles, tables, no images or web fonts.** Mail clients strip
  `<style>` blocks and rarely load fonts; Georgia stands in for Cormorant
  Garamond and Courier for DM Mono.
- Keep the plain `{{ .ConfirmationURL }}` fallback. Some clients mangle the
  button, and corporate scanners sometimes burn the one-use link, after which
  the person needs to request another.

After editing a template, send yourself a link from the sign-in page and check
it in a real inbox. Gmail and Outlook render HTML differently from a browser.
