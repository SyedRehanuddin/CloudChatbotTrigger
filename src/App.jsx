import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import {
  Activity, ArrowRight, BellRing, Check, CheckCircle2, ChevronRight,
  CircleAlert, Cloud, Code2, Copy, Database, Fingerprint, Globe2,
  LayoutDashboard, LockKeyhole, LogOut, MessageCircle, Radio,
  RefreshCw, Send, Server, ShieldCheck, Sparkles, TerminalSquare, Zap,
} from 'lucide-react'
import './App.css'

const API_BASE = 'https://s2fqrsa25m.execute-api.us-east-1.amazonaws.com'
const SEND_ENDPOINT = `${API_BASE}/send`
const HISTORY_ENDPOINT = `${API_BASE}/messages`
// Cognito public app client information, never a password or secret.
const COGNITO_LOGOUT_ENDPOINT = 'https://us-east-1nc9mzpomc.auth.us-east-1.amazoncognito.com/logout'
const COGNITO_CLIENT_ID = '15ef6nd851a6mepd49qlojrobr'
const MQTT_TOPIC = 'chatbot-trigger/events'
const MAX_MESSAGE = 500
const DEFAULT_MESSAGE = 'Hello from Cloud Chatbot Trigger!'
const REPO_URL = 'https://github.com/SyedRehanuddin/CloudChatbotTrigger'
const LAB_HINT = "If you're using AWS Academy Learner Lab, confirm that your lab session is running."
const ensureSentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`)
// Shown only as a possible cause next to HTTP 5xx failures, never as a diagnosis.
const withLabHint = (text) => `${ensureSentence(text)} ${LAB_HINT}`

// The backend uses the request_id UUID as its DynamoDB message_id.
// Retain an unresolved ID in this tab so a retry can't accidentally deliver twice.
const PENDING_KEY_PREFIX = 'cloudtrigger:pending-send:v1:'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const SHORTCUTS = [
  'Hello from our Cloud Computing project!',
  'AWS Lambda successfully triggered this message.',
  'Software-only IoT demonstration is working.',
]

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Overview', crumb: 'Overview', Icon: LayoutDashboard },
  { id: 'compose', label: 'Message trigger', crumb: 'Message Trigger', Icon: Send },
  { id: 'activity', label: 'Recent activity', crumb: 'Recent Activity', Icon: Activity },
  { id: 'architecture', label: 'Architecture', crumb: 'Architecture', Icon: Server },
]

// Architecture diagram data. Lambda runs these steps one after another
// (see backend/chatbot_trigger/lambda_function.py), not in parallel.
const DELIVERY_FLOW = [
  { Icon: LayoutDashboard, name: 'React Dashboard', note: 'Signed-in browser app' },
  { Icon: Fingerprint, name: 'Amazon Cognito', note: 'Sign-in, issues the JWT' },
  { Icon: Globe2, name: 'API Gateway', note: 'POST /send, JWT authorizer' },
  { Icon: Zap, name: 'AWS Lambda', note: 'ChatbotTrigger' },
]
const DELIVERY_STEPS = [
  { Icon: Database, name: 'DynamoDB', note: 'Store the request as PENDING' },
  { Icon: Radio, name: 'AWS IoT Core', note: `Publish MQTT to ${MQTT_TOPIC}` },
  { Icon: BellRing, name: 'Discord webhook', note: 'Post to #cloud-alerts' },
  { Icon: Database, name: 'DynamoDB', note: 'Save the final statuses' },
]
const HISTORY_FLOW = [
  { Icon: LayoutDashboard, name: 'React Dashboard', note: 'Loads after sign-in and on refresh' },
  { Icon: Globe2, name: 'API Gateway', note: 'GET /messages, Cognito-authorized' },
  { Icon: Code2, name: 'History Lambda', note: 'Reads only your own records' },
  { Icon: Database, name: 'DynamoDB GSI', note: 'user-sub-timestamp-index, newest 8' },
  { Icon: Activity, name: 'Recent Activity', note: 'Table and counters on this page' },
]

function FlowRow({ nodes }) {
  return (
    <ol className="flow-row">
      {nodes.map(({ Icon, name, note }, index) => (
        <li className="flow-item" key={name}>
          <div className="flow-node"><Icon size={16} strokeWidth={1.8} /><div><strong>{name}</strong><small>{note}</small></div></div>
          {index < nodes.length - 1 && <span className="flow-arrow" aria-hidden="true"><ArrowRight size={16} /></span>}
        </li>
      ))}
    </ol>
  )
}

const getDeliveryState = (status) => {
  if (['SENT', 'PUBLISHED', 'STORED', 'EXECUTED', 'AUTHORIZED'].includes(status)) return 'success'
  if (status === 'FAILED') return 'danger'
  return 'neutral'
}

function StatusLabel({ status, empty = 'Not tested' }) {
  const display = status || empty
  const tone = getDeliveryState(status)
  return <span className={`status-label ${tone}`}><span className="status-dot" />{display.replaceAll('_', ' ')}</span>
}

function MetricTile({ icon: Icon, label, value, hint, tone = '' }) {
  return (
    <div className="metric-tile">
      <div className="metric-head"><span>{label}</span><Icon size={17} strokeWidth={1.8} /></div>
      <div className={`metric-value ${tone}`}>{value}</div>
      <div className="metric-hint">{hint}</div>
    </div>
  )
}

function PipelineItem({ icon: Icon, name, detail, status, fallback }) {
  const tone = getDeliveryState(status)
  return (
    <div className="pipeline-item">
      <span className={`pipeline-icon ${status ? tone : ''}`}><Icon size={20} strokeWidth={1.7} /></span>
      <div className="pipeline-copy"><strong>{name}</strong><small>{detail}</small></div>
      <StatusLabel status={status} empty={fallback} />
    </div>
  )
}

function LoginScreen({ auth }) {
  return (
    <div className="login-screen">
      <div className="login-orb one" /><div className="login-orb two" />
      <div className="login-top"><div className="brand-emblem"><Radio size={24} /></div><span>CloudTrigger <span className="brand-muted">/ workspace</span></span></div>
      <div className="login-panel">
        <div className="eyebrow"><span className="eyebrow-line" />AWS CLOUD COMPUTING PROJECT</div>
        <span className="login-glyph"><MessageCircle size={32} strokeWidth={1.5} /></span>
        <h1>Messages, delivered<br /><span>through the cloud.</span></h1>
        <p>A secure, software-only message trigger powered by AWS Lambda, IoT Core, DynamoDB and Discord.</p>
        {auth.error && <div className="error-message"><CircleAlert size={17} /><span>{auth.error.message}</span></div>}
        <button className="primary-btn login-btn" onClick={() => void auth.signinRedirect()} disabled={Boolean(auth.activeNavigator)}>
          <LockKeyhole size={18} /> Sign in with Amazon Cognito <ArrowRight size={18} />
        </button>
        <div className="login-footnote"><ShieldCheck size={16} /> Protected by API Gateway JWT authorization</div>
        <div className="login-note">Accounts are provisioned by the project administrator in Amazon Cognito. There is no public sign-up.</div>
      </div>
      <div className="login-bottom"><span>AWS Academy · Cloud Computing</span><a className="login-link" href={REPO_URL} target="_blank" rel="noopener noreferrer">View source on GitHub</a></div>
    </div>
  )
}

export default function App() {
  const auth = useAuth()
  const [message, setMessage] = useState(DEFAULT_MESSAGE)
  const [sending, setSending] = useState(false)
  const [lastResult, setLastResult] = useState(null)
  const [activity, setActivity] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [error, setError] = useState('')
  const [selectedSection, setSelectedSection] = useState('dashboard')
  const [signingOut, setSigningOut] = useState(false)
  const [pendingRequest, setPendingRequest] = useState(null)
  const [pendingReady, setPendingReady] = useState(false)
  const [copied, setCopied] = useState('')
  const copyTimer = useRef(null)

  const displayName = auth.user?.profile?.email || 'Authorized member'
  const crumb = NAV_ITEMS.find((item) => item.id === selectedSection)?.crumb ?? 'Overview'
  const accessToken = auth.user?.access_token
  const sessionReady = auth.isAuthenticated && !auth.user?.expired && Boolean(accessToken)
  const storageKey = auth.user?.profile?.sub
    ? `${PENDING_KEY_PREFIX}${auth.user.profile.sub}`
    : null

  // Preserve just one unresolved send across refreshes in this browser tab.
  // No tokens or passwords are stored here; the user ID only namespaces the key.
  useEffect(() => {
    setPendingReady(false)
    if (!sessionReady || !storageKey) {
      setPendingRequest(null)
      setPendingReady(true)
      return
    }
    try {
      const value = sessionStorage.getItem(storageKey)
      const parsed = value ? JSON.parse(value) : null
      if (
        parsed && typeof parsed.message === 'string' &&
        parsed.message.length > 0 && parsed.message.length <= MAX_MESSAGE &&
        typeof parsed.request_id === 'string' && UUID_PATTERN.test(parsed.request_id)
      ) {
        setPendingRequest(parsed)
      } else {
        setPendingRequest(null)
        if (value) sessionStorage.removeItem(storageKey)
      }
    } catch {
      setPendingRequest(null)
    }
    setPendingReady(true)
  }, [sessionReady, storageKey])

  const savePendingRequest = (request) => {
    setPendingRequest(request)
    if (storageKey) {
      try { sessionStorage.setItem(storageKey, JSON.stringify(request)) } catch { /* tab storage unavailable */ }
    }
  }

  const clearPendingRequest = () => {
    setPendingRequest(null)
    if (storageKey) {
      try { sessionStorage.removeItem(storageKey) } catch { /* tab storage unavailable */ }
    }
  }

  const startFreshRequest = () => {
    if (!window.confirm('The earlier request might already have reached Discord. Start a NEW request anyway?')) return
    clearPendingRequest()
    setLastResult(null)
    setError('Previous request ID discarded. The next send will be a new message.')
  }

  useEffect(() => () => clearTimeout(copyTimer.current), [])

  // Presentation only: copy the ID shown in the pipeline panel.
  const handleCopyId = async () => {
    const id = lastResult?.message_id
    if (!id) return
    let ok = false
    try { await navigator.clipboard.writeText(id); ok = true } catch { /* clipboard blocked */ }
    setCopied(ok ? 'copied' : 'failed')
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(''), 1800)
  }

  // The list and summary counters below come from AWS DynamoDB, not localStorage.
  // API Gateway validates the JWT and the history Lambda queries by the user's sub.
  const loadActivity = useCallback(async (signal) => {
    if (!sessionReady) return
    setHistoryLoading(true)
    setHistoryError('')

    try {
      const response = await fetch(HISTORY_ENDPOINT, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
      })
      let data = {}
      try { data = await response.json() } catch { /* handled below */ }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('Your session is not authorized to read history. Sign in again.')
        }
        if (response.status === 429) {
          throw new Error('History requests are temporarily limited. Refresh shortly.')
        }
        const base = data.message || `History API returned HTTP ${response.status}.`
        throw new Error(response.status >= 500 ? withLabHint(base) : base)
      }
      if (!Array.isArray(data.messages)) {
        throw new Error('AWS returned an unexpected message history response.')
      }
      if (!signal?.aborted) setActivity(data.messages.slice(0, 8))
    } catch (err) {
      if (signal?.aborted || err.name === 'AbortError') return
      setHistoryError(err instanceof Error ? err.message : 'Unable to reach AWS message history.')
    } finally {
      if (!signal?.aborted) setHistoryLoading(false)
    }
  }, [accessToken, sessionReady])

  useEffect(() => {
    if (!sessionReady) {
      setActivity([])
      setHistoryError('')
      setHistoryLoading(false)
      return
    }
    const controller = new AbortController()
    void loadActivity(controller.signal)
    return () => controller.abort()
  }, [loadActivity, sessionReady])

  const metrics = useMemo(() => ({
    total: activity.length,
    delivered: activity.filter((item) => item.delivery_status === 'SENT').length,
    published: activity.filter((item) => item.iot_status === 'PUBLISHED').length,
  }), [activity])

  const scrollTo = (id) => {
    setSelectedSection(id)
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Clear the OIDC client's local session and terminate the hosted Cognito
  // browser session. The return URL is already registered in both environments.
  const handleSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)

    const logoutUrl = new URL(COGNITO_LOGOUT_ENDPOINT)
    logoutUrl.searchParams.set('client_id', COGNITO_CLIENT_ID)
    logoutUrl.searchParams.set(
      'logout_uri',
      `${window.location.origin}${import.meta.env.BASE_URL}`,
    )

    try {
      await auth.removeUser()
      window.location.assign(logoutUrl.toString())
    } catch {
      setSigningOut(false)
      setError('Could not clear the local session. Please try signing out again.')
    }
  }

  const handleSend = async (event) => {
    event.preventDefault()
    const trimmed = message.trim()
    if (sending || !trimmed || !pendingReady) return
    if (trimmed.length > MAX_MESSAGE) { setError('Message must be at most 500 characters.'); return }
    if (!sessionReady) {
      setError('Your session has expired. Please sign in again before sending.')
      return
    }
    if (pendingRequest && pendingRequest.message !== trimmed) {
      setError('An earlier send is unresolved. Restore that message to retry safely, or choose Start new request below.')
      return
    }

    // A new user action after a confirmed 200 gets a new UUID; an uncertain
    // request reuses its original UUID. Lambda deduplicates on this value.
    const requestId = pendingRequest?.request_id || crypto.randomUUID()
    const attempt = { request_id: requestId, message: trimmed }
    savePendingRequest(attempt) // Persist BEFORE the request leaves this tab.

    setSending(true)
    setError('')
    setLastResult(null)
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 22000)
    try {
      const response = await fetch(SEND_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ message: trimmed, request_id: requestId }),
        signal: abort.signal,
      })
      let result = {}
      try { result = await response.json() } catch { /* show meaningful error below */ }
      setLastResult({ ...result, httpStatus: response.status })

      // The GSI can be eventually consistent. Refresh re-queries DynamoDB.
      if (result.message_id) void loadActivity()

      if (response.status === 200 && result.message_id === requestId) {
        clearPendingRequest()
        return
      }

      if (response.status === 202) {
        setError('The previous request is still PENDING. Use Retry / check same request to check its status without sending a duplicate. If it stays pending, the backend may need attention.')
      } else if (response.status === 502 && result.message_id) {
        setError('AWS stored the message, but at least one delivery step failed. Retrying the same ID will NOT resend it. Check its statuses, or explicitly start a new request if needed.')
      } else if (response.status === 409) {
        setError('That request ID belongs to a different message or user. Use Start new request to deliberately generate a different ID.')
      } else if (response.status === 400) {
        clearPendingRequest()
        setError(result.message || 'The API rejected this message.')
      } else if (response.status === 401 || response.status === 403) {
        setError('API access denied. Sign in again; your request ID has been kept for a safe retry.')
      } else if (response.status === 429) {
        setError('Too many requests. Retry the same ID after the rate limit clears.')
      } else if (!response.ok) {
        const base = result.message || `AWS returned HTTP ${response.status}. Retry with the same request ID.`
        setError(response.status >= 500 ? withLabHint(base) : base)
      } else {
        // A 2xx response without a matching message ID is not proof of delivery.
        setError('The API returned an unexpected result. The same request ID is saved for a safe retry.')
      }
    } catch (err) {
      setError(err.name === 'AbortError'
        ? 'Request timed out. It may have been processed. Retry / check same request to avoid another Discord post.'
        : 'Could not confirm the AWS result. Retry / check same request when the network or Learner Lab is available.')
    } finally {
      clearTimeout(deadline)
      setSending(false)
    }
  }

  if (auth.isLoading || auth.activeNavigator) {
    return <div className="loading-screen"><span className="brand-emblem"><Radio size={24} /></span><h2>Connecting to CloudTrigger</h2><p>Checking your secure session…</p><span className="loading-spinner" /></div>
  }
  if (!auth.isAuthenticated) return <LoginScreen auth={auth} />

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-emblem"><Radio size={22} /></span><div><strong>CloudTrigger</strong><small>AWS CLOUD PROJECT</small></div></div>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {NAV_ITEMS.map(({ id, label, Icon }) => <button key={id} type="button" className={selectedSection === id ? 'nav-link active' : 'nav-link'} aria-current={selectedSection === id ? 'page' : undefined} onClick={() => scrollTo(id)}><Icon size={18} /> {label} <ChevronRight size={15} /></button>)}
        </nav>
        <div className="nav-caption platform-label">PLATFORM</div>
        <div className="platform-card"><span className="platform-icon"><Cloud size={18}/></span><div><strong>AWS us-east-1</strong><small>Remote serverless backend</small></div></div>
        <div className="sidebar-bottom"><div className="security-card"><ShieldCheck size={18} /><div><strong>JWT Protected</strong><small>Amazon Cognito authentication</small></div></div><div className="sidebar-version">CloudTrigger v1.0 · Software only</div></div>
      </aside>

      <div className="main-frame">
        <header className="topbar"><nav className="topbar-path" aria-label="Breadcrumb"><span>Workspace</span><ChevronRight size={15}/><strong aria-current="page">{crumb}</strong></nav><div className="topbar-right"><div className="environment-tag"><span className="live-pulse"/> CONNECTED SESSION</div><span className="avatar">{displayName.slice(0, 1).toUpperCase()}</span><button className="icon-button" type="button" title="Sign out from CloudTrigger and Cognito" aria-label="Sign out from CloudTrigger and Cognito" disabled={signingOut} onClick={() => void handleSignOut()}><LogOut size={17}/></button></div></header>

        <main className="content">
          <section id="dashboard" className="intro-section"><div><div className="eyebrow"><span className="eyebrow-line"/> SERVERLESS MESSAGING PLATFORM</div><h1>Message control <span>center.</span></h1><p>Send a message through the AWS backend and watch each service report its result.</p></div></section>

          <div className="dashboard-columns">
            <section id="compose" className="panel compose-panel"><div className="panel-header"><div><span className="section-overline">01 / ACTION</span><h2>Message trigger</h2><p>Send one message through the actual AWS backend.</p></div><span className="panel-icon"><Send size={19}/></span></div>
              <form onSubmit={handleSend}><label className="field-label" htmlFor="message">MESSAGE CONTENT</label><textarea id="message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={MAX_MESSAGE} rows={4} placeholder="Type a message for your Discord channel…" disabled={sending}/><div className="field-subrow"><span>Discord destination: <strong>#cloud-alerts</strong></span><span>{message.length} / {MAX_MESSAGE}</span></div>
              <div className="suggestions"><span className="field-label">QUICK MESSAGES</span><div className="suggestion-wrap">{SHORTCUTS.map((sample, index) => <button type="button" className="suggestion" key={sample} disabled={sending} onClick={() => setMessage(sample)}><Sparkles size={13}/>{index === 0 ? 'Project greeting' : index === 1 ? 'Lambda test' : 'IoT demo'}</button>)}</div></div>
              {pendingRequest && !sending && <div className="retry-notice" role="status">
                <div><strong>Unresolved request · {pendingRequest.request_id.slice(0, 8)}…</strong><p>Safe retry uses the same ID. It will not create another Discord message if AWS already stored it.</p></div>
                <div className="retry-actions">
                  {message.trim() !== pendingRequest.message && <button type="button" onClick={() => { setMessage(pendingRequest.message); setError('') }}>Restore pending message</button>}
                  <button type="button" onClick={startFreshRequest}>Start new request</button>
                </div>
              </div>}
              {error && <div className="error-message" role="alert"><CircleAlert size={18}/><span>{error}</span></div>}
              {lastResult?.httpStatus === 200 && !error && <div className="success-message" role="status"><CheckCircle2 size={18}/>Message sent. AWS stored it, published it to IoT Core and posted it to #cloud-alerts.</div>}
              <button className="primary-btn send-btn" type="submit" disabled={sending || !message.trim() || auth.user?.expired || !pendingReady || (pendingRequest && message.trim() !== pendingRequest.message)}>{sending ? <RefreshCw size={18} className="spin"/> : <Send size={18}/>} {sending ? 'Processing request…' : pendingRequest ? 'Retry / check same request' : 'Send cloud message'} <ArrowRight size={17}/></button>
              </form>
            </section>

            <section className="panel pipeline-panel"><div className="panel-header"><div><span className="section-overline">02 / OBSERVABILITY</span><h2>Execution pipeline</h2><p>Results from the most recent request.</p></div><span className="panel-icon"><Activity size={19}/></span></div>
              <div className="pipeline-list"><PipelineItem icon={ShieldCheck} name="Cognito / API Gateway" detail="JWT-authorized POST /send" status={[200, 202, 502].includes(lastResult?.httpStatus) ? 'AUTHORIZED' : null} fallback="Waiting"/><PipelineItem icon={Code2} name="AWS Lambda" detail="Validate and process request" status={lastResult?.message_id ? 'EXECUTED' : null} fallback="Waiting"/><PipelineItem icon={Database} name="Amazon DynamoDB" detail="Persist message & delivery state" status={lastResult?.status === 'STORED' ? 'STORED' : null} fallback="Waiting"/><PipelineItem icon={Radio} name="AWS IoT Core" detail={MQTT_TOPIC} status={lastResult?.iot_status} fallback="Waiting"/><PipelineItem icon={MessageCircle} name="Discord webhook" detail="#cloud-alerts channel" status={lastResult?.delivery_status} fallback="Waiting"/></div>
              <div className="result-details">
                <div className="result-line"><span>LAST MESSAGE ID</span><span>HTTP RESPONSE <strong>{lastResult?.httpStatus || '—'}</strong></span></div>
                <div className="id-row"><code>{lastResult?.message_id || 'No request executed yet'}</code>{lastResult?.message_id && <button type="button" className={`copy-btn ${copied}`} onClick={() => void handleCopyId()} aria-label="Copy last message ID" title="Copy message ID">{copied === 'copied' ? <Check size={14}/> : <Copy size={14}/>}{copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}</button>}</div>
                {lastResult?.database_synced === false && <small className="note-danger">Warning: DynamoDB status update did not complete.</small>}
                <span className="sr-only" role="status">{copied === 'copied' ? 'Message ID copied' : ''}</span>
              </div>
            </section>
          </div>

          <div className="metric-caption"><strong>LAST 8 MESSAGES</strong><span>Counts cover the latest eight DynamoDB records, not lifetime totals.</span></div>
          <section className="metric-grid" aria-label="Summary of the latest eight messages">
            <MetricTile icon={MessageCircle} label="Recent requests" value={metrics.total} hint="Latest 8 records"/>
            <MetricTile icon={CheckCircle2} label="Discord sent" value={metrics.delivered} hint="Webhook accepted · latest 8" tone="metric-green"/>
            <MetricTile icon={Radio} label="MQTT published" value={metrics.published} hint="IoT Core publish · latest 8" tone="metric-blue"/>
            <MetricTile icon={LockKeyhole} label="API authorization" value="JWT" hint="Cognito · openid scope"/>
          </section>

          <section id="activity" className="panel activity-panel">
            <div className="panel-header">
              <div><span className="section-overline">03 / CLOUD HISTORY</span><h2>Recent activity</h2><p>Latest eight messages from your DynamoDB history, protected by your Cognito login.</p></div>
              <button type="button" className="panel-icon history-refresh" title="Refresh cloud history" aria-label="Refresh cloud history" onClick={() => void loadActivity()} disabled={historyLoading || !sessionReady}>
                <RefreshCw size={19} className={historyLoading ? 'spin' : ''}/>
              </button>
            </div>
            {historyError && <div className="error-message" role="alert"><CircleAlert size={18}/><span>{ensureSentence(historyError)} Use Refresh to try again.</span></div>}
            {historyLoading && activity.length === 0 ?
              <div className="empty-activity" role="status"><RefreshCw size={28} className="spin"/><strong>Loading AWS history…</strong><span>Reading messages from DynamoDB.</span></div>
              : activity.length === 0 && !historyError ?
              <div className="empty-activity"><TerminalSquare size={31}/><strong>No cloud messages yet</strong><span>Send a message above, then refresh if it takes a moment to appear.</span></div>
              : activity.length > 0 ?
              <div className="activity-table-wrapper"><table className="activity-table"><thead><tr><th>MESSAGE</th><th>TIME</th><th>MQTT</th><th>DISCORD</th></tr></thead><tbody>{activity.map((entry) => <tr key={entry.message_id}><td><strong title={entry.message}>{entry.message}</strong><small>{entry.message_id.slice(0, 12)}…</small></td><td>{new Date(entry.timestamp).toLocaleString(undefined, {dateStyle:'medium',timeStyle:'short'})}</td><td><StatusLabel status={entry.iot_status}/></td><td><StatusLabel status={entry.delivery_status}/></td></tr>)}</tbody></table></div>
              : null}
            {activity.length > 0 && <p className="history-footnote">DynamoDB · Most recent 8 messages for your account · Refresh to check for new records</p>}
          </section>

          <section id="architecture" className="architecture-section"><div className="section-overline">04 / ARCHITECTURE</div><h2>Built on real AWS services</h2><p>A signed-in browser calls a JWT-protected API. Lambda does the work, DynamoDB keeps the record, and Discord receives the notification.</p>
            <div className="flow-card">
              <div className="flow-head"><strong>Message delivery</strong><code>POST /send</code></div>
              <div className="flow-delivery">
                <FlowRow nodes={DELIVERY_FLOW} />
                <span className="flow-arrow" aria-hidden="true"><ArrowRight size={16}/></span>
                <div className="flow-steps">
                  <div className="flow-steps-title">LAMBDA THEN CALLS, IN ORDER</div>
                  <ol aria-label="Services called by Lambda, in order">{DELIVERY_STEPS.map(({ Icon, name, note }, index) => <li className="flow-node" key={`${name}-${index}`}><span className="flow-step">{index + 1}</span><Icon size={16} strokeWidth={1.8}/><div><strong>{name}</strong><small>{note}</small></div></li>)}</ol>
                </div>
              </div>
              <p className="flow-note">New requests follow a sequential workflow; retries of completed requests reuse the saved result without repeating delivery. IoT Core only publishes the MQTT event; the Discord post is a separate webhook call from Lambda. Lambda returns each step&apos;s status to the dashboard.</p>
            </div>
            <div className="flow-card">
              <div className="flow-head"><strong>Message history</strong><code>GET /messages</code></div>
              <FlowRow nodes={HISTORY_FLOW} />
            </div>
          </section>
          <footer className="app-footer"><span>CloudTrigger · AWS Cloud Computing Project · AWS Academy Learner Lab</span><span><ShieldCheck size={14}/> Cognito session · JWT-protected API</span></footer>
        </main>
      </div>
    </div>
  )
}
