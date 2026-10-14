// CrewBus M5 Mobile Theme Tokens & Styles — site brand, system light/dark.
// Palettes mirror the marketing-site tokens; the scheme follows the OS via
// useColorScheme (ThemeProvider/useTheme, default dark). THEME + STYLES stay
// as frozen DARK-built aliases so existing imports keep working.
import React from 'react';
import { useColorScheme } from 'react-native';

// Site-token aliases: the marketing site names colors acc / accInk / accMuted /
// warn / warnMuted / ink / dim / line. Screens use the canonical keys above
// (primary, onPrimary, …); these map the site names onto the same values so
// either vocabulary works. Derived, never hand-copied — no drift.
const withAliases = (t) => Object.freeze({
  ...t,
  ink: t.text,
  dim: t.textSubtle,
  line: t.border,
  acc: t.primary,
  accInk: t.onPrimary,
  accMuted: t.primaryMuted,
  warn: t.amber,
  warnMuted: t.amberMuted,
});

export const LIGHT = withAliases(Object.freeze({
  scheme: 'light',
  bg: '#f4f6f3',
  card: '#ffffff',
  cardElevated: '#e9ede9',
  border: '#d5ddd7',
  borderFocus: '#9db8a9',
  primary: '#0e8a55',
  primaryLight: '#0b7a49',
  primaryMuted: 'rgba(14, 138, 85, 0.12)',
  emerald: '#0e8a55',
  emeraldMuted: 'rgba(14, 138, 85, 0.12)',
  amber: '#b86e00',
  amberMuted: 'rgba(184, 110, 0, 0.12)',
  rose: '#db3a5a',
  roseMuted: 'rgba(219, 58, 90, 0.12)',
  text: '#14201a',
  textMuted: '#43544b',
  textSubtle: '#5b6a62',
  textDim: '#8a978f',
  softFill: 'rgba(20, 32, 26, 0.06)',
  onPrimary: '#ffffff',
}));

export const DARK = withAliases(Object.freeze({
  scheme: 'dark',
  bg: '#0f1419',
  card: '#182028',
  cardElevated: '#202b36',
  border: '#2a343e',
  borderFocus: '#3d4c5a',
  primary: '#4cc38a',
  primaryLight: '#6fd6a1',
  primaryMuted: 'rgba(76, 195, 138, 0.16)',
  emerald: '#4cc38a',
  emeraldMuted: 'rgba(76, 195, 138, 0.16)',
  amber: '#ffb454',
  amberMuted: 'rgba(255, 180, 84, 0.16)',
  rose: '#f43f5e',
  roseMuted: 'rgba(244, 63, 94, 0.18)',
  text: '#e3e9ee',
  textMuted: '#aeb9c2',
  textSubtle: '#8b98a5',
  textDim: '#5f6d78',
  softFill: 'rgba(255, 255, 255, 0.06)',
  onPrimary: '#07130d',
}));

export function getTheme(scheme) {
  return scheme === 'light' ? LIGHT : DARK;
}

// Names the site design doc uses for the same two frozen palettes.
export const LIGHT_THEME = LIGHT;
export const DARK_THEME = DARK;

// Deprecated alias: frozen dark palette for backward-compat imports.
export const THEME = DARK;

export function buildStyles(theme) {
  return {
    screen: { flex: 1, backgroundColor: theme.bg },
    body: { flex: 1, padding: 14, gap: 10 },
    card: {
      backgroundColor: theme.card,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.border,
      padding: 12,
      gap: 8,
    },
    cardTitle: { color: theme.text, fontSize: 14, fontWeight: '700' },
    cardSub: { color: theme.textMuted, fontSize: 12, lineHeight: 17 },
    text: { color: theme.text, fontSize: 13 },
    textMuted: { color: theme.textMuted, fontSize: 12 },
    statusPill: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 99,
      alignSelf: 'flex-start',
    },
    input: {
      backgroundColor: theme.cardElevated,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 7,
      color: theme.text,
      fontSize: 13,
    },
    btnPrimary: {
      backgroundColor: theme.primary,
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnSecondary: {
      backgroundColor: theme.cardElevated,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingVertical: 7,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnDanger: {
      backgroundColor: theme.roseMuted,
      borderWidth: 1,
      borderColor: theme.rose,
      borderRadius: 8,
      paddingVertical: 7,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnSuccess: {
      backgroundColor: theme.emeraldMuted,
      borderWidth: 1,
      borderColor: theme.emerald,
      borderRadius: 8,
      paddingVertical: 7,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnText: { color: theme.text, fontSize: 13, fontWeight: '600' },
    btnPrimaryText: { color: theme.onPrimary, fontSize: 13, fontWeight: '600' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    // Shared watchdog-banner + empty-list treatment (warn-tinted). Every screen
    // renders the alert and "nothing here" copy from here, so the two look
    // identical in both schemes instead of drifting per screen.
    alertBox: {
      borderWidth: 1,
      borderColor: theme.amber,
      backgroundColor: theme.amberMuted,
      borderRadius: 8,
      padding: 10,
      marginBottom: 8,
      gap: 4,
    },
    alertTitle: { color: theme.amber, fontSize: 13, fontWeight: '700' },
    dismiss: { color: theme.textSubtle, fontSize: 12, textAlign: 'right' },
    empty: { color: theme.textSubtle, textAlign: 'center', marginTop: 40, fontSize: 13 },
  };
}

// Backward-compat constant built from DARK (see buildStyles for theming).
export const STYLES = buildStyles(DARK);

const ThemeContext = React.createContext(DARK);

export function ThemeProvider({ children, scheme }) {
  const system = useColorScheme();
  const value = getTheme(scheme || system || 'dark');
  return React.createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme() {
  return React.useContext(ThemeContext);
}

export function useStyles() {
  const T = useTheme();
  const S = React.useMemo(() => buildStyles(T), [T]);
  return { T, S };
}

