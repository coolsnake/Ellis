import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Login } from '../components/Login'

export const LoginPage: React.FC = () => {
  const [error, setError] = React.useState<string | null>(null)
  const navigate = useNavigate()

  const apiBase = (import.meta as any).env?.VITE_API_BASE ?? '/api'

  const handleSubmit = (creds: { user: string; pass: string }) => {
    setError(null)
    const token = btoa(`${creds.user}:${creds.pass}`)
    fetch(`${apiBase}/system`, { headers: { Authorization: `Basic ${token}` } })
      .then(r => { if (!r.ok) throw new Error('Invalid credentials'); return r.json(); })
      .then(() => {
        try { localStorage.setItem('authCreds', JSON.stringify(creds)) } catch {}
        navigate('/', { replace: true })
      })
      .catch(() => setError('Invalid username or password'))
  }

  return <Login onSubmit={handleSubmit} error={error} />
}


