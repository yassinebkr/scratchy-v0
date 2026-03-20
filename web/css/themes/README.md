# Scratchy Themes (Skins)

## Architecture

```
css/themes/
  base.css              → Design tokens (variables only, no components)
  liquid-glass-dark.css → Dark theme values
  liquid-glass-light.css→ Light theme values
css/style.css           → All component styles (references theme variables)
```

## Creating a New Skin

1. **Copy an existing theme file** (e.g. `liquid-glass-dark.css`)
2. **Rename it** (e.g. `cyberpunk.css`)
3. **Change the selector** to your theme name:
   ```css
   :root[data-theme="cyberpunk"] {
     --surface-0: #0a001a;
     /* ... override all variables ... */
   }
   ```
4. **Add to `index.html`** in `<head>`:
   ```html
   <link rel="stylesheet" href="css/themes/cyberpunk.css?v=..." id="theme-cyberpunk" disabled>
   ```
5. **Activate it** in JavaScript:
   ```js
   document.documentElement.dataset.theme = 'cyberpunk';
   ```

## Variable Reference

See `base.css` for the full list of tokens. Key groups:

- **Surfaces**: `--surface-0` through `--surface-4` (depth layers)
- **Glass**: `--glass-subtle`, `--glass-medium`, `--glass-strong`, `--glass-border`
- **Text**: `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-ghost`
- **Accent**: `--accent`, `--accent-hover`, `--accent-muted`, `--accent-border`
- **Semantic**: `--success`, `--warning`, `--error`, `--info` (each with `-muted` and `-border`)
- **Borders**: `--border-subtle`, `--border-default`, `--border-strong`, `--divider`

## Backward Compatibility

Old variable names (`--bg-primary`, `--bg-secondary`, `--border`, etc.) are aliased in `base.css` to point to the new names.
