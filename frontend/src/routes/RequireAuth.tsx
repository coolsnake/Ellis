import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'

export const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation()
  let creds: { user: string; pass: string } | null = null
  try {
    const s = localStorage.getItem('authCreds')
    const obj = s ? JSON.parse(s) : null
    const exp = Number(obj?.expiresAt ?? NaN)
    if (!obj || !Number.isFinite(exp) || exp <= Date.now()) {
      try { localStorage.removeItem('authCreds') } catch {}
      creds = null
    } else {
      creds = obj
    }
  } catch {}

  if (!creds) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  return <>{children}</>
}


