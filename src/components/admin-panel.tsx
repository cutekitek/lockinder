'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Ban, ExternalLink, Eye, EyeOff, LoaderCircle, Search, ShieldCheck, X } from 'lucide-react';
import { translator } from '@/lib/i18n';
import type { Locale } from '@/lib/model';
import type { adminReports, adminUsers } from '@/lib/admin';
import { SECRET_SETTINGS, type SettingKey, type SettingsSnapshot } from '@/lib/settings-definition';

type UsersPage = ReturnType<typeof adminUsers>;
type ReportsPage = ReturnType<typeof adminReports>;
type AdminUser = UsersPage['users'][number];
type T = ReturnType<typeof translator>;

async function request<T>(path: string, signal?: AbortSignal, value?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { cache: 'no-store', signal, ...(value === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'unavailable');
  return result;
}

function usePage<T>(path: string | null, version = 0) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void (async () => {
      setState({ data: null, error: null, loading: true });
      try {
        const data = await request<T>(path, controller.signal);
        if (!controller.signal.aborted) setState({ data, error: null, loading: false });
      } catch (error) {
        if (!controller.signal.aborted) setState({ data: null, error: error instanceof Error ? error.message : 'unavailable', loading: false });
      }
    })();
    return () => controller.abort();
  }, [path, version]);
  return state;
}

function Pager({ data, onPage, t }: { data: { page: number; totalPages: number; total: number }; onPage: (page: number) => void; t: T }) {
  return <nav className="admin-pagination" aria-label={t('pagination')}>
    <span>{t('totalUsers')}: {data.total} · {t('page')} {data.page} / {data.totalPages}</span>
    <div><button className="secondary" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)} aria-label={t('previousPage')}><ArrowLeft size={16} />{t('previousPage')}</button>
      <button className="secondary" disabled={data.page >= data.totalPages} onClick={() => onPage(data.page + 1)} aria-label={t('nextPage')}>{t('nextPage')}<ArrowRight size={16} /></button></div>
  </nav>;
}

function Reports({ target, locale, t, onClose }: { target: string; locale: Locale; t: T; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const { data, error, loading } = usePage<ReportsPage>(`admin/users/${target}/reports?page=${page}`, version);
  return <section className="panel admin-reports" aria-label={t('playerReports')}>
    <div className="admin-section-heading"><h2>{t('playerReports')}{data ? `: ${data.user.name}` : ''}</h2><button onClick={onClose} aria-label={t('closeReports')}><X size={20} /></button></div>
    {loading ? <p role="status">{t('loadingAdmin')}</p> : error ? <p role="alert">{t(error)} <button className="text-button" onClick={() => setVersion(v => v + 1)}>{t('retry')}</button></p> : data && <>
      {data.reports.length ? <div className="admin-report-list">{data.reports.map(report => <article key={report.id}>
        <div className="admin-report-meta"><a href={`https://steamcommunity.com/profiles/${report.reporterSteamId}`} target="_blank" rel="noreferrer">{report.reporterName}<ExternalLink size={13} /></a><time dateTime={new Date(report.createdAt).toISOString()}>{new Date(report.createdAt).toLocaleString(locale)}</time></div>
        <p>{report.text}</p>
      </article>)}</div> : <p className="muted">{t('noPlayerReports')}</p>}
      <Pager data={data} onPage={setPage} t={t} />
    </>}
  </section>;
}

function BanDialog({ user, t, onClose, onSaved }: { user: AdminUser; t: T; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => { element?.close(); trigger?.focus(); };
  }, []);
  return <dialog ref={dialog} className="complaint-modal panel" aria-labelledby="ban-title" aria-describedby="ban-hint" onCancel={event => { event.preventDefault(); if (!sending.current) onClose(); }}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (sending.current) return;
      sending.current = true; setBusy(true); setError(null);
      try { await request('admin/ban', undefined, { target: user.id, banned: !user.banned }); onSaved(); }
      catch (error) { setError(error instanceof Error ? error.message : 'unavailable'); }
      finally { sending.current = false; setBusy(false); }
    }}>
      <h2 id="ban-title">{t(user.banned ? 'unbanUser' : 'banUser')}: {user.name}</h2>
      <p id="ban-hint">{t(user.banned ? 'unbanHint' : 'banHint')}</p>
      {error && <p role="alert" className="warning-text">{t(error)}</p>}
      <div className="complaint-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>{t('cancel')}</button><button className="primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={16} />}{t(user.banned ? 'unbanUser' : 'banUser')}</button></div>
    </form>
  </dialog>;
}

export function AdminPanel({ locale }: { locale: Locale }) {
  const t = translator(locale);
  const [scope, setScope] = useState<'all' | 'reported' | 'settings'>('all');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);
  const [saved, setSaved] = useState(false);
  const { data, error, loading } = usePage<UsersPage>(scope === 'settings' ? null : `admin/users?${new URLSearchParams({ scope, q: query, page: String(page) })}`, version);
  const changePage = (next: number) => { setPage(next); setSelected(null); };
  return <div className="admin-panel">
    <div className="page-title"><h1>{t('admin')}</h1><p>{t('adminHint')}</p></div>
    <div className="admin-tabs" role="group" aria-label={t('adminSections')}>{(['all', 'reported', 'settings'] as const).map(value => <button key={value} className="secondary" aria-pressed={scope === value} onClick={() => { setScope(value); changePage(1); }}>{t(value === 'all' ? 'allUsers' : value === 'reported' ? 'reportedUsers' : 'adminSettings')}</button>)}</div>
    {scope === 'settings' ? <SettingsPanel t={t} /> : <>
    <form className="admin-search" onSubmit={event => { event.preventDefault(); setQuery(draft.trim()); changePage(1); }}>
      <label htmlFor="admin-search">{t('searchUsers')}</label><div><input id="admin-search" value={draft} maxLength={100} placeholder={t('searchUsersHint')} onChange={event => setDraft(event.target.value)} /><button className="primary"><Search size={16} />{t('search')}</button></div>
    </form>
    {saved && <p role="status" className="admin-feedback">{t('moderationSaved')}</p>}
    {loading ? <p role="status">{t('loadingAdmin')}</p> : error ? <div role="alert" className="panel"><p>{t(error)}</p><button className="secondary" onClick={() => setVersion(v => v + 1)}>{t('retry')}</button></div> : data && <>
      <section className="panel admin-users" aria-label={t(scope === 'all' ? 'allUsers' : 'reportedUsers')}>
        <div className="admin-table-scroll"><table>
          <thead><tr><th>{t('user')}</th><th>{t('status')}</th><th>{t('registeredAt')}</th><th>{t('playerReports')}</th><th>{t('moderation')}</th></tr></thead>
          <tbody>{data.users.map(user => <tr key={user.id}>
            <td><strong>{user.name}</strong><a href={`https://steamcommunity.com/profiles/${user.steamId}`} target="_blank" rel="noreferrer">{user.steamId}<ExternalLink size={12} /></a>{user.discordUsername && <small>Discord: @{user.discordUsername}</small>}</td>
            <td data-label={t('status')}><span className={`admin-status ${user.banned ? 'is-banned' : ''}`}>{t(user.banned ? 'banned' : !user.complete ? 'incompleteProfile' : user.paused ? 'pausedProfile' : 'activeProfile')}</span>{!user.canBan && <small>{t('administrator')}</small>}</td>
            <td data-label={t('registeredAt')}><time dateTime={new Date(user.createdAt).toISOString()}>{new Date(user.createdAt).toLocaleDateString(locale)}</time></td>
            <td data-label={t('playerReports')}>{user.reportCount ? <><button className="text-button" onClick={() => setSelected(user.id)} aria-expanded={selected === user.id}>{t('viewReports')} ({user.reportCount})</button>{user.lastReportAt && <small>{new Date(user.lastReportAt).toLocaleString(locale)}</small>}</> : <span className="muted">0</span>}</td>
            <td data-label={t('moderation')}>{user.canBan && <button className={`secondary ${user.banned ? '' : 'danger'}`} onClick={() => { setSaved(false); setBanTarget(user); }}>{user.banned ? <ShieldCheck size={14} /> : <Ban size={14} />}{t(user.banned ? 'unbanUser' : 'banUser')}</button>}</td>
          </tr>)}</tbody>
        </table></div>
        {!data.users.length && <p className="admin-empty">{t(scope === 'reported' && !query ? 'noReportedUsers' : 'noUsers')}</p>}
        <Pager data={data} onPage={changePage} t={t} />
      </section>
      {selected && <Reports key={selected} target={selected} locale={locale} t={t} onClose={() => setSelected(null)} />}
    </>}
    {banTarget && <BanDialog user={banTarget} t={t} onClose={() => setBanTarget(null)} onSaved={() => { setBanTarget(null); setSaved(true); setVersion(v => v + 1); }} />}
    </>}
  </div>;
}

const settingsGroups: { title: string; keys: SettingKey[] }[] = [
  { title: 'settingsGeneral', keys: ['APP_URL', 'ADMIN_STEAM_IDS'] },
  { title: 'settingsSteam', keys: ['STEAM_API_KEY'] },
  { title: 'settingsDeadlock', keys: ['DEADLOCK_API_KEY'] },
  { title: 'settingsDiscord', keys: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_ADMIN_USER_ID', 'DISCORD_GUILD_ID', 'DISCORD_INVITE_URL'] }
];

function SettingsPanel({ t }: { t: T }) {
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState(false);
  const { data, error, loading } = usePage<SettingsSnapshot>('admin/settings', version);
  return <section className="admin-settings" aria-label={t('adminSettings')}>
    <h2>{t('adminSettings')}</h2><p className="muted">{t('settingsHint')}</p>
    {saved && <p className="admin-feedback" role="status">{t('settingsSaved')}</p>}
    {loading ? <p role="status">{t('loadingSettings')}</p> : error ? <div role="alert"><p>{t(error)}</p><button className="secondary" onClick={() => setVersion(v => v + 1)}>{t('retry')}</button></div> : data && <SettingsForm key={data.revision} data={data} t={t} onSaved={() => { setSaved(true); setVersion(v => v + 1); }} onReload={() => { setSaved(false); setVersion(v => v + 1); }} />}
  </section>;
}

function SettingsForm({ data, t, onSaved, onReload }: { data: SettingsSnapshot; t: T; onSaved: () => void; onReload: () => void }) {
  const [values, setValues] = useState<Partial<Record<SettingKey, string>>>(data.values);
  const [cleared, setCleared] = useState<Partial<Record<SettingKey, boolean>>>({});
  const [shown, setShown] = useState<Partial<Record<SettingKey, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const changes: Partial<Record<SettingKey, string>> = {};
  for (const group of settingsGroups) for (const key of group.keys) {
    const value = cleared[key] ? '' : values[key] || '';
    if (value !== data.values[key]) changes[key] = value;
  }
  return <form onSubmit={async event => {
    event.preventDefault();
    if (sending.current || !Object.keys(changes).length) return;
    sending.current = true; setBusy(true); setError(null);
    try { await request('admin/settings', undefined, { revision: data.revision, values: changes }); onSaved(); }
    catch (error) { setError(error instanceof Error ? error.message : 'unavailable'); }
    finally { sending.current = false; setBusy(false); }
  }}>
    <div className="settings-grid">{settingsGroups.map(group => <fieldset className="panel settings-group" disabled={busy} key={group.title}>
      <legend>{t(group.title)}</legend>
      {group.keys.map(key => {
        const secret = SECRET_SETTINGS.includes(key);
        return <div className="setting-field" key={key}>
          <label htmlFor={`setting-${key}`}>{t(`setting_${key}`)}<code>{key}</code></label>
          <div className="setting-input"><input id={`setting-${key}`} type={secret && !shown[key] ? 'password' : key.endsWith('URL') ? 'url' : 'text'} value={cleared[key] ? '' : values[key] || ''} maxLength={4096} autoComplete="off" spellCheck={false} disabled={!!cleared[key]} required={key === 'APP_URL' || key === 'ADMIN_STEAM_IDS'}
            placeholder={secret ? t('secretMissing') : undefined}
            onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} />
            {secret && <button type="button" className="secondary" disabled={!!cleared[key]} aria-label={`${t(shown[key] ? 'hideSecret' : 'showSecret')} ${t(`setting_${key}`)}`} aria-pressed={!!shown[key]} onClick={() => setShown(current => ({ ...current, [key]: !current[key] }))}>{shown[key] ? <EyeOff size={17} /> : <Eye size={17} />}</button>}
          </div>
          <small>{t(`settingHint_${key}`)}</small>
          {secret && data.configured[key] && <label className="setting-clear"><input type="checkbox" checked={!!cleared[key]} onChange={event => setCleared(current => ({ ...current, [key]: event.target.checked }))} />{t('removeSecret')} {t(`setting_${key}`)}</label>}
        </div>;
      })}
    </fieldset>)}</div>
    <div className="panel settings-bootstrap"><strong>DATABASE_PATH</strong><code>{data.databasePath}</code><p className="muted">{t('databaseBootstrapHint')}</p></div>
    {error && <p className="warning-text" role="alert">{t(error)}</p>}
    <div className="settings-save"><button type="button" className="secondary" disabled={busy} onClick={onReload}>{t('reloadSettings')}</button><button className="primary" disabled={busy || !Object.keys(changes).length}>{busy && <LoaderCircle className="spin" size={16} />}{t('saveSettings')}</button></div>
  </form>;
}
