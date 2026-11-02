import { createContext, useContext } from 'react'
/** Shell supplies exactly the eligibility used by its display-none classes, without adding DOM. */
export const WidgetVisibility = createContext(true)
export const useWidgetVisibility = () => useContext(WidgetVisibility)
