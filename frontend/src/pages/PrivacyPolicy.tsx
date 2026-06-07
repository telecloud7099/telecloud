import { Link } from 'react-router-dom'

const SECTIONS = [
  {
    title: '1. Information We Collect',
    intro: 'We collect the following information when you use our service:',
    items: [
      'Phone number (for Telegram authentication)',
      'Files you upload to your Telegram Saved Messages',
      'Session data for maintaining your login',
    ],
  },
  {
    title: '2. How We Use Your Information',
    intro: 'Your information is used solely to:',
    items: [
      'Authenticate you with Telegram',
      'Upload files to your Telegram Saved Messages',
      'Retrieve files from your Telegram Saved Messages',
    ],
  },
  {
    title: '3. Data Storage and Security',
    intro: 'We implement the following security measures:',
    items: [
      'All session data is encrypted',
      'Files are temporarily stored and immediately deleted after upload',
      'HTTPS encryption for all data transmission',
      'Automatic session timeout after 1 hour of inactivity',
    ],
  },
  {
    title: '4. Your Rights',
    intro: 'You have the right to:',
    items: [
      'Request deletion of your data',
      'Access your stored information',
      'Withdraw consent at any time',
    ],
  },
]

export default function PrivacyPolicy() {
  return (
    <div className="policy-page">
      <div className="policy-card">
        <h1 className="policy-title">Privacy Policy</h1>
        <p className="policy-date">Last updated: {new Date().toLocaleDateString()}</p>

        {SECTIONS.map(s => (
          <section key={s.title} className="policy-section">
            <h2>{s.title}</h2>
            <p>{s.intro}</p>
            <ul>
              {s.items.map(item => <li key={item}>{item}</li>)}
            </ul>
          </section>
        ))}

        <section className="policy-section">
          <h2>5. Contact Information</h2>
          <p>For privacy-related questions, please reach out via the app settings.</p>
        </section>

        <Link to="/login" className="btn btn-ghost" style={{ marginTop: '1.5rem', display: 'inline-flex' }}>
          ← Back
        </Link>
      </div>
    </div>
  )
}
