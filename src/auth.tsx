import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { api, setApiUser } from './api.ts'
import type { Rec } from './api.ts'

interface AuthCtx {
  user: Rec | null
  login: (userName: string, password: string) => Promise<Rec>
  logout: () => void
}

const Ctx = createContext<AuthCtx | null>(null)
const KEY = 'sn-clone-user'

function loadUser(): Rec | null {
  try {
    const raw = localStorage.getItem(KEY)
    const u = raw ? (JSON.parse(raw) as Rec) : null
    setApiUser(u?.sys_id ?? null)
    return u
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Rec | null>(loadUser)
  const login = async (userName: string, password: string) => {
    const u = await api.login(userName, password)
    localStorage.setItem(KEY, JSON.stringify(u))
    setApiUser(u.sys_id)
    setUser(u)
    return u
  }
  const logout = () => {
    localStorage.removeItem(KEY)
    setApiUser(null)
    setUser(null)
  }
  return <Ctx.Provider value={{ user, login, logout }}>{children}</Ctx.Provider>
}

// oxlint-disable-next-line react/only-export-components
export function useAuth(): AuthCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth must be used inside AuthProvider')
  return v
}

export const isAgent = (u: Rec | null) => u?.role === 'admin' || u?.role === 'itil'
