import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'

export const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation()
  let creds: { user: string; pass: string } | null = null
  try {
    const s = localStorage.getItem('authCreds')
    creds = s ? JSON.parse(s) : null
  } catch {}

  if (!creds) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  return <>{children}</>
}


