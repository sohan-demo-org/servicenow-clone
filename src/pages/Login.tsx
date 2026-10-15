import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isAgent, useAuth } from '../auth.tsx'
import { ApiError } from '../api.ts'

const DEMO = [
  { user: 'admin', label: 'System Administrator', role: 'admin' },
  { user: 'beth.anglin', label: 'Beth Anglin', role: 'itil (agent)' },
  { user: 'abel.tuter', label: 'Abel Tuter', role: 'end user' },
]

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [userName, setUserName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const submit = async (u = userName, p = password) => {
    setError('')
    try {
      const user = await login(u, p)
      navigate(isAgent(user) ? '/' : '/sp')
    } catch (e) {
      setError((e as ApiError).message)
    }
  }

  return (
    <div className="sn-login">
      <div className="sn-login-card">
        <div className="sn-login-logo">
          service<span>now</span>
          <small>clone</small>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <label htmlFor="user_name">User name</label>
          <input id="user_name" className="sn-input" value={userName} onChange={(e) => setUserName(e.target.value)} autoFocus />
          <label htmlFor="user_password">Password</label>
          <input id="user_password" type="password" className="sn-input" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && (
            <div className="sn-msg error" role="alert">
              {error}
            </div>
          )}
          <button className="sn-btn primary block" type="submit" data-testid="login-submit">
            Log in
          </button>
        </form>
        <div className="sn-login-demo">
          <div className="muted">Demo accounts (password: demo)</div>
          {DEMO.map((d) => (
            <button key={d.user} className="sn-demo-user" onClick={() => submit(d.user, 'demo')}>
              <b>{d.label}</b>
              <span>
                {d.user} · {d.role}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="sn-login-foot">Unaffiliated demo clone for illustration purposes. Not a ServiceNow product.</div>
    </div>
  )
}
