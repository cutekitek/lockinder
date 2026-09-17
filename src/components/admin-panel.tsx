'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Ban, ExternalLink, LoaderCircle, Search, ShieldCheck, X } from 'lucide-react';
import { translator } from '@/lib/i18n';
import type { Locale } from '@/lib/model';
import type { adminReports, adminUsers } from '@/lib/admin';

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

function usePage<T>(path: string, version = 0) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  useEffect(() => {
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
  const [scope, setScope] = useState<'all' | 'reported'>('all');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);
  const [saved, setSaved] = useState(false);
  const { data, error, loading } = usePage<UsersPage>(`admin/users?${new URLSearchParams({ scope, q: query, page: String(page) })}`, version);
  const changePage = (next: number) => { setPage(next); setSelected(null); };
  return <div className="admin-panel">
    <div className="page-title"><h1>{t('admin')}</h1><p>{t('adminHint')}</p></div>
    <div className="admin-tabs" role="group" aria-label={t('userLists')}>{(['all', 'reported'] as const).map(value => <button key={value} className="secondary" aria-pressed={scope === value} onClick={() => { setScope(value); changePage(1); }}>{t(value === 'all' ? 'allUsers' : 'reportedUsers')}</button>)}</div>
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
  </div>;
}
