import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Consent from './pages/Consent'
import Setup from './pages/Setup'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import PrivacyPolicy from './pages/PrivacyPolicy'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Consent />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/privacy-policy" element={<PrivacyPolicy />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
