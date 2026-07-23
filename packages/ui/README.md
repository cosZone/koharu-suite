# `@koharu-suite/ui`

Private React primitives shared inside the koharu-suite workspace. This package is not a public API and
is not published to npm during M1.

Consumers import components and CSS separately:

```tsx
import { Button } from '@koharu-suite/ui';
import '@koharu-suite/ui/styles.css';
```

Mount primitives below `data-koharu-ui`. Add `data-koharu-ui-tone="inverse"` to the same boundary for
the inverse palette. The package intentionally exports no global `:root`, `body`, `label`, or `input`
styles.

## Tooling compatibility

The package pins Vite 7.3.6 locally because Storybook 10.2.9 declares compatibility with Vite 5–7.
Its local React plugin remains on the latest release compatible with that Vite boundary. Admin remains
on the workspace Vite 8 catalog entry. Do not deduplicate the package-local Vite to the workspace
catalog until Storybook declares Vite 8 support.
