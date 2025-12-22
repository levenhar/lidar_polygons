# Toolbar Layout Documentation

## Overview
The toolbar has been reorganized into a modern, clean structure following Material 3 / Fluent / iOS design principles with strict 2-row-per-column layout rules.

## Layout Rules
- **Maximum 2 rows per column**: Each column can contain up to 2 buttons stacked vertically
- **Automatic column expansion**: Categories with 3+ buttons automatically create additional columns
- **Consistent spacing**: Modern spacing, alignment, and padding throughout
- **Button hierarchy**: Primary/Secondary/Tertiary/Destructive button styles maintained

## Wireframe Layout

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ TOOLBAR                                                                              │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                       │
│ ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐│
│ │ DATA MANAGEMENT  │  │ PLANNING OPTIONS │  │     HISTORY      │  │  VIEW CONTROLS   ││
│ │                  │  │                  │  │                  │  │                  ││
│ │ ┌──────────────┐ │  │ ┌──────────────┐ │  │ ┌──────────────┐ │  │ ┌──────────────┐ ││
│ │ │  Load DTM    │ │  │ │  Draw Path   │ │  │ │    Undo      │ │  │ │ Fit to DTM  │ ││
│ │ └──────────────┘ │  │ └──────────────┘ │  │ └──────────────┘ │  │ └──────────────┘ ││
│ │ ┌──────────────┐ │  │ ┌──────────────┐ │  │ ┌──────────────┐ │  │ ┌──────────────┐ ││
│ │ │ Unload DTM   │ │  │ │Create Parallel│ │  │ │    Redo      │ │  │ │ Reset View  │ ││
│ │ └──────────────┘ │  │ │    Line      │ │  │ └──────────────┘ │  │ └──────────────┘ ││
│ │                  │  │ └──────────────┘ │  │                  │  │                  ││
│ │ ┌──────────────┐ │  │                  │  │                  │  │                  ││
│ │ │Delete All    │ │  │                  │  │                  │  │                  ││
│ │ │   Points     │ │  │                  │  │                  │  │                  ││
│ │ └──────────────┘ │  │                  │  │                  │  │                  ││
│ │   (Column 2)     │  │                  │  │                  │  │                  ││
│ └──────────────────┘  └──────────────────┘  └──────────────────┘  └──────────────────┘│
│                                                                                       │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Category Breakdown

### 1. Data Management (3 buttons → 2 columns)
**Column 1:**
- Load DTM (Secondary)
- Unload DTM (Destructive) - conditional

**Column 2:**
- Delete All Points (Destructive) - conditional

### 2. Planning Options (2 buttons → 1 column)
**Column 1:**
- Draw Path (Primary)
- Create Parallel Line (Secondary)

### 3. History (2 buttons → 1 column)
**Column 1:**
- Undo (Secondary)
- Redo (Secondary)

### 4. View Controls (2 buttons → 1 column)
**Column 1:**
- Fit to DTM (Tertiary)
- Reset View (Tertiary)

### 5. Data Export (2 buttons → 1 column) - Header Section
**Column 1:**
- Export GeoJSON (Secondary)
- Import GeoJSON (Secondary)

## Implementation Details

### CSS Structure
- `.map-controls`: Main toolbar container with flexbox layout
- `.control-group`: Category container with title and columns
- `.group-columns`: Flex container for multiple columns within a category
- `.group-column`: Individual column (max 2 buttons vertically)
- `.group-title`: Category title styling

### Key Features
- **Responsive**: Categories wrap on smaller screens
- **Consistent spacing**: 2rem gap between categories, 0.75rem between columns
- **Button sizing**: 140-160px width per column
- **Modern styling**: Material 3 inspired with subtle shadows and transitions

## Button Hierarchy

1. **Primary** (`btn-primary`): Main actions (e.g., Draw Path)
   - Blue background (#2563eb)
   - White text
   - Elevated shadow

2. **Secondary** (`btn-secondary`): Standard actions
   - Transparent background
   - Gray border
   - Hover effects

3. **Tertiary** (`btn-tertiary`): View/navigation actions
   - Light gray text
   - Subtle border
   - Minimal styling

4. **Destructive** (`btn-destructive`): Delete/remove actions
   - Red text (#dc2626)
   - Red border
   - Warning styling

## Visual Design Principles

- **Spacing**: Consistent 0.5rem gap between buttons in a column
- **Padding**: 1.25rem vertical, 1.5rem horizontal toolbar padding
- **Typography**: 0.6875rem uppercase category titles with letter spacing
- **Shadows**: Subtle elevation (0 1px 3px) for depth
- **Borders**: 1px solid #e5e7eb for separation
- **Transitions**: Smooth 0.2s cubic-bezier transitions on all interactive elements


