# The Founder raven (bundled)

| File | Use |
|---|---|
| `founder-raven.svg` | above 48 px, light surfaces (the intro card at 56 px, the profile sheet at 128 px) |
| `founder-raven-small.svg` | 48 px and below, light surfaces (the roster row at 32 px, the header at 22 px) |
| `founder-raven-on-bone.svg` | above 48 px, dark surfaces, where the dark ring disappears |
| `founder-raven-on-bone-small.svg` | 48 px and below, dark surfaces |

Rules (from the design source):

- Use the small files at 48 px and below; the full feather detail turns to noise.
- On dark surfaces use the on-bone variant (Tailwind's `dark:` variant picks it).
- Never recolour, rotate or stretch: always square, drawn as an image, the circle as it is.
- The 1024 px PNG is not bundled: it is the Matrix profile photo the owner sets once, so other
  clients (Element X) show the raven too.
- Founder account only: never a stand-in for the Atum mark or the app icon.

The files are the designer's own, unchanged (their provenance manifest included); they are
loaded as images, so the master's `fr-clip` id never meets the page's ids.
