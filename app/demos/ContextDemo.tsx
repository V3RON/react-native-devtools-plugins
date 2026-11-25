import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import { DemoBox, DemoButton } from './ui';

// React Context + useReducer for the React Context DevTool extension, which walks the
// fiber tree through `__REACT_DEVTOOLS_GLOBAL_HOOK__` (React Native installs that hook
// for its built-in React DevTools) and shows Context values and useReducer actions.
type Settings = { theme: 'light' | 'dark'; fontScale: number };
type Action = { type: 'toggleTheme' } | { type: 'bigger' } | { type: 'reset' };

const initial: Settings = { theme: 'light', fontScale: 1 };

function settingsReducer(state: Settings, action: Action): Settings {
  switch (action.type) {
    case 'toggleTheme':
      return { ...state, theme: state.theme === 'light' ? 'dark' : 'light' };
    case 'bigger':
      return { ...state, fontScale: Math.round((state.fontScale + 0.1) * 10) / 10 };
    case 'reset':
      return initial;
  }
}

const SettingsContext = createContext<{ settings: Settings; dispatch: Dispatch<Action> } | null>(null);
SettingsContext.displayName = 'SettingsContext';

function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, dispatch] = useReducer(settingsReducer, initial);
  return <SettingsContext.Provider value={{ settings, dispatch }}>{children}</SettingsContext.Provider>;
}

function SettingsControls() {
  const ctx = useContext(SettingsContext)!;
  const { theme, fontScale } = ctx.settings;
  return (
    <DemoBox title={`React Context: theme ${theme}, font ×${fontScale}`} color="#087ea4">
      <DemoButton color="#087ea4" label="Toggle theme" onPress={() => ctx.dispatch({ type: 'toggleTheme' })} />
      <DemoButton color="#087ea4" label="Bigger" onPress={() => ctx.dispatch({ type: 'bigger' })} />
      <DemoButton color="#087ea4" label="Reset" onPress={() => ctx.dispatch({ type: 'reset' })} />
    </DemoBox>
  );
}

export function ContextDemo() {
  return (
    <SettingsProvider>
      <SettingsControls />
    </SettingsProvider>
  );
}
