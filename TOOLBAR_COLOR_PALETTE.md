# Toolbar Color Palette Documentation

## Selected Color Palette

### 1. Primary Shade: `#F0F9FF`
- **Usage**: Main toolbar background areas
- **Description**: Very light cyan-blue that provides a soft, elegant, and colorful base for toolbar interfaces
- **Applied to**:
  - `.app-header` background
  - `.map-controls` background

### 2. Secondary Shade: `#7DD3FC`
- **Usage**: Category headers, separators, and borders
- **Description**: Light sky blue that creates vibrant visual separation and hierarchy
- **Applied to**:
  - `.group-title` border-bottom (category headers)
  - `.header-group .group-title` border-bottom
  - Toolbar border-bottom
  - Button borders (default state)
  - Button borders (disabled state)

### 3. Highlight/Accent Shade: `#0EA5E9`
- **Usage**: Active/selected buttons and hover states
- **Description**: Vibrant sky blue accent color that provides clear visual feedback for interactive elements
- **Applied to**:
  - `.btn-primary` background (primary action buttons)
  - `.btn-primary:hover` background
  - `.btn-secondary:hover` border and text color
  - `.btn-secondary.active` border and text color
  - `.btn-tertiary:hover` border and text color
  - All active button states

## Palette Logic

This color palette follows modern design principles with a vibrant, colorful approach:

1. **High Contrast & Readability**: The light cyan-blue background (#F0F9FF) against white content areas creates pleasant distinction while maintaining excellent text readability. The vibrant sky blue accent (#0EA5E9) provides strong contrast for interactive elements.

2. **Colorful, Yet Elegant Tones**: The palette uses a harmonious blue color scheme that adds visual interest while maintaining a professional and refined appearance. The sky blue tones create a fresh, modern look without being overwhelming.

3. **Vibrant & Engaging**: The colorful palette creates clear visual hierarchy and makes the interface more engaging. The blue tones evoke a sense of clarity and professionalism while being more visually appealing than neutral grays.

## Color Mapping

### Toolbar Backgrounds
- `.app-header` → `#F0F9FF` (Primary - Light Cyan Blue)
- `.map-controls` → `#F0F9FF` (Primary - Light Cyan Blue)

### Category Headers/Separators
- `.group-title` → Border: `#7DD3FC` (Secondary - Sky Blue), Text: `#0369A1` (Deep Sky Blue)
- `.header-group .group-title` → Border: `#7DD3FC` (Secondary - Sky Blue), Text: `#0369A1` (Deep Sky Blue)

### Borders
- Toolbar bottom borders → `#7DD3FC` (Secondary - Sky Blue)
- Button default borders → `#7DD3FC` (Secondary - Sky Blue)
- Button disabled borders → `#7DD3FC` (Secondary - Sky Blue)

### Active/Selected States
- `.btn-primary` → Background: `#0EA5E9` (Highlight - Vibrant Sky Blue)
- `.btn-primary:hover` → Background: `#0284C7` (Highlight variant - Deeper Sky Blue)
- `.btn-primary.active` → Background: `#0EA5E9` (Highlight), Border: `#0284C7`

### Hover States
- `.btn-secondary:hover` → Border: `#0EA5E9` (Highlight), Text: `#0EA5E9` (Highlight), Background: `#E0F2FE` (Very Light Sky Blue)
- `.btn-secondary.active` → Border: `#0EA5E9` (Highlight), Text: `#0EA5E9` (Highlight), Background: `#E0F2FE` (Very Light Sky Blue)
- `.btn-tertiary:hover` → Border: `#0EA5E9` (Highlight), Text: `#0EA5E9` (Highlight), Background: `#E0F2FE` (Very Light Sky Blue)

## Tailwind CSS Variables (Optional)

For easy implementation in Tailwind-based projects:

```css
:root {
  --toolbar-primary: #F0F9FF;
  --toolbar-secondary: #7DD3FC;
  --toolbar-highlight: #0EA5E9;
  --toolbar-highlight-hover: #0284C7;
  --toolbar-highlight-active: #0369A1;
  --toolbar-text: #0369A1;
}
```

Usage in Tailwind:
- `bg-[var(--toolbar-primary)]` for toolbar backgrounds
- `border-[var(--toolbar-secondary)]` for borders and separators
- `bg-[var(--toolbar-highlight)]` for active/selected states
- `hover:border-[var(--toolbar-highlight)]` for hover states

## Implementation Notes

- All color changes are scoped **exclusively** to toolbar elements
- No changes were made to:
  - Map container
  - Chart/visualization areas
  - Content panels
  - Other UI elements outside toolbars
- The palette maintains accessibility standards with sufficient contrast ratios
- All interactive states (hover, active, disabled) have been updated to use the new palette

