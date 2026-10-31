import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import {
  Activity, ArrowRight, BellRing, CheckCircle2, ChevronRight,
  CircleAlert, Cloud, Code2, Database, Fingerprint, Globe2,
  LayoutDashboard, LockKeyhole, LogOut, MessageCircle, Radio,
  RefreshCw, Send, Server, ShieldCheck, Sparkles, TerminalSquare, Zap,
} from 'lucide-react'
import './App.css'

const API_BASE = 'https://s2fqrsa25m.execute-api.us-east-1.amazonaws.com'
const SEND_ENDPOINT = `${API_BASE}/send`
const HISTORY_ENDPOINT = `${API_BASE}/messages`
const MQTT_TOPIC = 'chatbot-trigger/events'
const MAX_MESSAGE = 500
const DEFAULT_MESSAGE = 'Hello from Cloud Chatbot Trigger!'

const SHORTCUTS = [
  'Hello from our Cloud Computing project!',
  'AWS Lambda successfully triggered this message.',
  'Software-only IoT demonstration is working.',
]

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
        <div className="eyebrow"><span className="eyebrow-line" />AWS SERVERLESS PROJECT · PRODUCT 20</div>
        <span className="login-glyph"><MessageCircle size={32} strokeWidth={1.5} /></span>
        <h1>Messages, delivered<br /><span>through the cloud.</span></h1>
        <p>A secure, software-only message trigger powered by AWS Lambda, IoT Core, DynamoDB and Discord.</p>
        {auth.error && <div className="error-message"><CircleAlert size={17} /><span>{auth.error.message}</span></div>}
        <button className="primary-btn login-btn" onClick={() => void auth.signinRedirect()} disabled={Boolean(auth.activeNavigator)}>
          <LockKeyhole size={18} /> Sign in with Amazon Cognito <ArrowRight size={18} />
        </button>
        <div className="login-footnote"><ShieldCheck size={16} /> Protected by API Gateway JWT authorization</div>
      </div>
      <div className="login-bottom"><span>AWS Academy · Cloud Computing</span><span>Software-only implementation</span></div>
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

  const displayName = auth.user?.profile?.email || 'Authorized member'
  const accessToken = auth.user?.access_token
  const sessionReady = auth.isAuthenticated && !auth.user?.expired && Boolean(accessToken)

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
        throw new Error(data.message || `History API returned HTTP ${response.status}.`)
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

  const handleSend = async (event) => {
    event.preventDefault()
    const trimmed = message.trim()
    if (sending || !trimmed) return
    if (trimmed.length > MAX_MESSAGE) { setError('Message must be at most 500 characters.'); return }
    const accessToken = auth.user?.access_token
    if (!auth.isAuthenticated || auth.user?.expired || !accessToken) {
      setError('Your session has expired. Please sign in again before sending.'); return
    }

    setSending(true)
    setError('')
    setLastResult(null)
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 22000)
    try {
      const response = await fetch(SEND_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ message: trimmed }),
        signal: abort.signal,
      })
      let result = {}
      try { result = await response.json() } catch { /* show meaningful error below */ }
      setLastResult({ ...result, httpStatus: response.status })
      // A newly written DynamoDB GSI entry may take a moment to be queryable.
      // If the row is not shown immediately, the Refresh button fetches it again.
      if (result.message_id) void loadActivity()
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) setError('API access denied. Sign in again or verify Cognito authorization.')
        else if (response.status === 429) setError('Too many requests. Wait a few seconds before sending again.')
        else if (response.status === 502 && result.message_id) setError('Message was stored, but one delivery step failed. Check the status below before retrying.')
        else setError(result.message || `AWS returned HTTP ${response.status}.`)
      }
    } catch (err) {
      setError(err.name === 'AbortError'
        ? 'Request timed out. The message may have been processed. Check Discord and DynamoDB before retrying.'
        : 'Could not reach the AWS API. Check your connection and whether the Learner Lab is running.')
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
        <div className="brand"><span className="brand-emblem"><Radio size={22} /></span><div><strong>CloudTrigger</strong><small>AWS PROJECT / 20</small></div></div>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          <button className={selectedSection === 'dashboard' ? 'nav-link active' : 'nav-link'} onClick={() => scrollTo('dashboard')}><LayoutDashboard size={18} /> Overview <ChevronRight size={15} /></button>
          <button className={selectedSection === 'compose' ? 'nav-link active' : 'nav-link'} onClick={() => scrollTo('compose')}><Send size={18} /> Message trigger <ChevronRight size={15} /></button>
          <button className={selectedSection === 'activity' ? 'nav-link active' : 'nav-link'} onClick={() => scrollTo('activity')}><Activity size={18} /> Recent activity <ChevronRight size={15} /></button>
          <button className={selectedSection === 'architecture' ? 'nav-link active' : 'nav-link'} onClick={() => scrollTo('architecture')}><Server size={18} /> Architecture <ChevronRight size={15} /></button>
        </nav>
        <div className="nav-caption platform-label">PLATFORM</div>
        <div className="platform-card"><span className="platform-icon"><Cloud size={18}/></span><div><strong>AWS us-east-1</strong><small>Remote serverless backend</small></div></div>
        <div className="sidebar-bottom"><div className="security-card"><ShieldCheck size={18} /><div><strong>JWT Protected</strong><small>Amazon Cognito authentication</small></div></div><div className="sidebar-version">CloudTrigger v1.0 · Software only</div></div>
      </aside>

      <div className="main-frame">
        <header className="topbar"><div className="topbar-path"><span>Workspace</span><ChevronRight size={15}/><strong>Overview</strong></div><div className="topbar-right"><div className="environment-tag"><span className="live-pulse"/> CONNECTED SESSION</div><span className="avatar">{displayName.slice(0, 1).toUpperCase()}</span><button className="icon-button" title="Sign out of this dashboard" onClick={() => void auth.removeUser()}><LogOut size={17}/></button></div></header>

        <main className="content">
          <section id="dashboard" className="intro-section"><div><div className="eyebrow"><span className="eyebrow-line"/> SERVERLESS MESSAGING PLATFORM</div><h1>Message control <span>center.</span></h1><p>Trigger a cloud workflow, watch each service respond, and verify Discord delivery—all without physical hardware.</p></div><div className="intro-icon"><Zap size={31} strokeWidth={1.7}/></div></section>

          <div className="hero-banner"><div className="hero-copy"><div className="hero-kicker"><span className="live-pulse"/> CLOUD WORKFLOW READY</div><h2>One click. Four AWS-connected steps.</h2><p>Secure request → Lambda processing → DynamoDB + IoT Core → Discord notification.</p><button className="hero-cta" onClick={() => scrollTo('compose')}>Trigger a message <ArrowRight size={16}/></button></div><div className="hero-mark"><span className="orb-core"><Radio size={53}/></span><span className="orb-ring ring-1"/><span className="orb-ring ring-2"/></div></div>

          <section className="metric-grid" aria-label="Cloud message history summary">
            <MetricTile icon={MessageCircle} label="Recent requests" value={metrics.total} hint="Last 8 DynamoDB records"/>
            <MetricTile icon={CheckCircle2} label="Discord delivered" value={metrics.delivered} hint="Confirmed successful sends" tone="metric-green"/>
            <MetricTile icon={Radio} label="MQTT published" value={metrics.published} hint="IoT Core publish results" tone="metric-blue"/>
            <MetricTile icon={LockKeyhole} label="API authorization" value="JWT" hint="Cognito · openid scope"/>
          </section>

          <div className="dashboard-columns">
            <section id="compose" className="panel compose-panel"><div className="panel-header"><div><span className="section-overline">01 / ACTION</span><h2>Message trigger</h2><p>Send one message through the actual AWS backend.</p></div><span className="panel-icon"><Send size={19}/></span></div>
              <form onSubmit={handleSend}><label className="field-label" htmlFor="message">MESSAGE CONTENT</label><textarea id="message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={MAX_MESSAGE} rows={5} placeholder="Type a message for your Discord channel…" disabled={sending}/><div className="field-subrow"><span>Discord destination: <strong>#cloud-alerts</strong></span><span>{message.length} / {MAX_MESSAGE}</span></div>
              <div className="suggestions"><span className="field-label">QUICK MESSAGES</span><div className="suggestion-wrap">{SHORTCUTS.map((sample, index) => <button type="button" className="suggestion" key={sample} disabled={sending} onClick={() => setMessage(sample)}><Sparkles size={13}/>{index === 0 ? 'Project greeting' : index === 1 ? 'Lambda test' : 'IoT demo'}</button>)}</div></div>
              {error && <div className="error-message" role="alert"><CircleAlert size={18}/><span>{error}</span></div>}
              {lastResult && !error && <div className="success-message" role="status"><CheckCircle2 size={18}/>Backend responded successfully. Check the delivery statuses alongside.</div>}
              <button className="primary-btn send-btn" type="submit" disabled={sending || !message.trim() || auth.user?.expired}>{sending ? <RefreshCw size={18} className="spin"/> : <Send size={18}/>} {sending ? 'Processing request…' : 'Send cloud message'} <ArrowRight size={17}/></button>
              </form>
            </section>

            <section className="panel pipeline-panel"><div className="panel-header"><div><span className="section-overline">02 / OBSERVABILITY</span><h2>Execution pipeline</h2><p>Results from the most recent request.</p></div><span className="panel-icon"><Activity size={19}/></span></div>
              <div className="pipeline-list"><PipelineItem icon={ShieldCheck} name="Cognito / API Gateway" detail="JWT-authorized POST /send" status={lastResult?.httpStatus === 200 || lastResult?.httpStatus === 502 ? 'AUTHORIZED' : null} fallback="Waiting"/><PipelineItem icon={Code2} name="AWS Lambda" detail="Validate and process request" status={lastResult?.message_id ? 'EXECUTED' : null} fallback="Waiting"/><PipelineItem icon={Database} name="Amazon DynamoDB" detail="Persist message & delivery state" status={lastResult?.status === 'STORED' ? 'STORED' : null} fallback="Waiting"/><PipelineItem icon={Radio} name="AWS IoT Core" detail={MQTT_TOPIC} status={lastResult?.iot_status} fallback="Waiting"/><PipelineItem icon={MessageCircle} name="Discord webhook" detail="#cloud-alerts channel" status={lastResult?.delivery_status} fallback="Waiting"/></div>
              <div className="result-details"><span>LAST MESSAGE ID</span><code>{lastResult?.message_id || 'No request executed yet'}</code><span>HTTP RESPONSE</span><strong>{lastResult?.httpStatus || '—'}</strong>{lastResult?.database_synced === false && <small className="note-danger">Warning: DynamoDB status update did not complete.</small>}</div>
            </section>
          </div>

          <section id="activity" className="panel activity-panel">
            <div className="panel-header">
              <div><span className="section-overline">03 / CLOUD HISTORY</span><h2>Recent activity</h2><p>Latest eight messages from your DynamoDB history, protected by your Cognito login.</p></div>
              <button type="button" className="panel-icon history-refresh" title="Refresh cloud history" aria-label="Refresh cloud history" onClick={() => void loadActivity()} disabled={historyLoading || !sessionReady}>
                <RefreshCw size={19} className={historyLoading ? 'spin' : ''}/>
              </button>
            </div>
            {historyError && <div className="error-message" role="alert"><CircleAlert size={18}/><span>{historyError} Use Refresh to try again.</span></div>}
            {historyLoading && activity.length === 0 ?
              <div className="empty-activity" role="status"><RefreshCw size={28} className="spin"/><strong>Loading AWS history…</strong><span>Reading messages from DynamoDB.</span></div>
              : activity.length === 0 && !historyError ?
              <div className="empty-activity"><TerminalSquare size={31}/><strong>No cloud messages yet</strong><span>Send a message above, then refresh if it takes a moment to appear.</span></div>
              : activity.length > 0 ?
              <div className="activity-table-wrapper"><table className="activity-table"><thead><tr><th>MESSAGE</th><th>TIME</th><th>MQTT</th><th>DISCORD</th></tr></thead><tbody>{activity.map((entry) => <tr key={entry.message_id}><td><strong title={entry.message}>{entry.message}</strong><small>{entry.message_id.slice(0, 12)}…</small></td><td>{new Date(entry.timestamp).toLocaleString(undefined, {dateStyle:'medium',timeStyle:'short'})}</td><td><StatusLabel status={entry.iot_status}/></td><td><StatusLabel status={entry.delivery_status}/></td></tr>)}</tbody></table></div>
              : null}
            {activity.length > 0 && <p className="history-footnote">DynamoDB · Most recent 8 messages for your account · Refresh to check for new records</p>}
          </section>

          <section id="architecture" className="architecture-section"><div className="section-overline">04 / ARCHITECTURE</div><h2>Built on real AWS services</h2><p>Software-only design. A browser replaces the physical trigger button; AWS IoT Core provides MQTT messaging without an ESP32.</p><div className="architecture-grid">{[
            {Icon: Fingerprint, name: 'Amazon Cognito', description: 'Authenticated user session'},
            {Icon: Globe2, name: 'API Gateway', description: 'Protected HTTPS endpoint'},
            {Icon: Zap, name: 'AWS Lambda', description: 'Serverless message processor'},
            {Icon: Database, name: 'DynamoDB', description: 'Cloud message records'},
            {Icon: Radio, name: 'AWS IoT Core', description: 'MQTT event publishing'},
            {Icon: BellRing, name: 'Discord webhook', description: 'Delivery to cloud-alerts'},
          ].map(({Icon, name, description}) => <div className="architecture-card" key={name}><Icon size={21}/><strong>{name}</strong><span>{description}</span></div>)}</div></section>
          <footer className="app-footer"><span>CloudTrigger · Product 20 · AWS Academy Learner Lab</span><span><ShieldCheck size={14}/> Session-based frontend · No physical hardware</span></footer>
        </main>
      </div>
    </div>
  )
}
