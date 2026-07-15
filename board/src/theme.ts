import { createTheme } from '@mui/material/styles';

// Dark TV theme using the project's validated palette (see dataviz notes):
// surfaces #0d0d0d / #1a1a19, status colors chosen for 3:1 on the dark surface.
export const theme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#0d0d0d', paper: '#1a1a19' },
    primary: { main: '#3987e5' },
    error: { main: '#d03b3b' },
    warning: { main: '#fab219' },
    success: { main: '#0ca30c' },
    text: { primary: '#ffffff', secondary: '#c3c2b7' },
    divider: 'rgba(255,255,255,0.10)',
  },
  typography: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    h1: { fontSize: '1.5rem', fontWeight: 650 },
    h2: { fontSize: '1.05rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' },
    h3: { fontSize: '2.7rem', fontWeight: 750, fontVariantNumeric: 'tabular-nums' },
    h6: { fontSize: '1.28rem', fontWeight: 580, lineHeight: 1.28 },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiChip: {
      styleOverrides: {
        root: { fontSize: '0.9rem' },
      },
    },
  },
});

/** Extra tone used for HIGH priority (between warning and error). */
export const SERIOUS = '#ec835a';
