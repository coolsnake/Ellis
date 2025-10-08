import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom'
import { RequireAuth } from './routes/RequireAuth'
import { AppShell } from './app/AppShell'
import { AppProviders } from './app/AppProviders'
import { LoginPage } from './pages/LoginPage'
import './styles.css'
import './utils/api'

const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<RequireAuth><AppProviders><AppShell /></AppProviders></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)


