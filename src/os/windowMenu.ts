import { createContext, useContext, type MouseEvent } from 'react'

// Lets an app open its window's full right-click menu from its own controls (a sticky's ⋯ button,
// a right-click in its text). Window.tsx provides it; apps read it with useWindowMenu().

export const WindowMenuContext = createContext<(e: MouseEvent) => void>(() => {})

export const useWindowMenu = () => useContext(WindowMenuContext)
