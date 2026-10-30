import React from 'react'
import ReactDOM from 'react-dom/client'
import { AuthProvider } from 'react-oidc-context'
import App from './App.jsx'
import './index.css'

// Public Cognito application identifiers only. Never put passwords,
// Discord webhooks, or private AWS credentials in the frontend.
const cognitoConfig = {
  authority: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_NC9MZPOmc',
  client_id: '15ef6nd851a6mepd49qlojrobr',
  redirect_uri: `${window.location.origin}${import.meta.env.BASE_URL}`,
  response_type: 'code',
  scope: 'openid email',
  automaticSilentRenew: false,
  onSigninCallback: () => {
    window.history.replaceState({}, document.title, window.location.pathname)
  },
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider {...cognitoConfig}>
      <App />
    </AuthProvider>
  </React.StrictMode>,
)
