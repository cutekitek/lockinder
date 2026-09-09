'use client';

/* Remote game and Steam assets have variable sizes and are rendered directly. */
/* eslint-disable @next/next/no-img-element */
/* Authentication endpoints require a full browser navigation, never router prefetch. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Compass, ExternalLink, Globe2, Heart, LoaderCircle, LogOut, MessageCircle, ShieldCheck, SlidersHorizontal, UserRound, UsersRound, X, Ban, RefreshCw, Copy, Gamepad2 } from 'lucide-react';
import countries from 'i18n-iso-countries';
import countryEn from 'i18n-iso-countries/langs/en.json';
import countryRu from 'i18n-iso-countries/langs/ru.json';
import { LANGUAGES, ROLES, rankPosition, type Catalog, type Filters, type Locale, type Player } from '@/lib/model';
import { translator } from '@/lib/i18n';
import type { getMe } from '@/lib/service';

countries.registerLocale(countryEn); countries.registerLocale(countryRu);
type Me = ReturnType<typeof getMe> & { discordInvite: string | null; discordConfigured: boolean };
type Detail = Player & { discordUsername?: string | null; discordId?: string | null; steamUrl?: string | null };
type T = ReturnType<typeof translator>;
type Run = (task: () => Promise<void>, success?: string) => Promise<boolean>;
async function api<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, value === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'unavailable');
  return data;
}
function language(code: string, locale: Locale) { return new Intl.DisplayNames([locale], { type: 'language' }).of(code) || code; }
function country(code: string, locale: Locale) { return countries.getName(code, locale) || code; }
function Avatar({ player, large = false }: { player: Pick<Player, 'avatar' | 'name'>; large?: boolean }) {
  return <span className={`avatar ${large ? 'large' : ''}`}>{player.avatar ? <img src={player.avatar} alt="" referrerPolicy="no-referrer" /> : player.name.slice(0, 1).toUpperCase()}</span>;
}
function Rank({ player, catalog, t }: { player: Player; catalog: Catalog | null; t: T }) {
  const asset = catalog?.ranks.find(r => r.tier === player.tier);
  return <span className="rank">{asset?.image && !!player.tier && <img src={asset.image} alt="" />}<span>{player.tier ? `${asset?.name || player.tier} ${['', 'I', 'II', 'III', 'IV', 'V', 'VI'][player.division || 0]}` : player.tier === 0 ? t('unranked') : t('unavailableRank')}</span></span>;
}
function Empty({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return <div className="empty"><span className="empty-icon"><UsersRound size={34} /></span><h2>{title}</h2><p>{text}</p>{children}</div>;
}
function Loading({ t }: { t: T }) { return <div className="loading" role="status"><LoaderCircle className="spin" />{t('loading')}</div>; }

export function App() {
  const path = usePathname(); const router = useRouter();
  const [locale, setLocale] = useState<Locale>('en');
  const [me, setMe] = useState<Me | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ key: string; error: boolean } | null>(null);
  const [bootError, setBootError] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedError, setFeedError] = useState(false);
  const [feedVersion, setFeedVersion] = useState(0);
  const t = translator(locale);
  const refresh = useCallback(async () => { setMe(await api<Me>('me')); }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      const saved = localStorage.getItem('lockinder-locale');
      const preferred = saved === 'ru' || saved === 'en' ? saved : navigator.language.startsWith('ru') ? 'ru' : 'en';
      if (active) setLocale(preferred);
      try {
        const user = await api<Me>('me');
        if (active) { setMe(user); if (!saved) setLocale(user.locale === 'ru' ? 'ru' : 'en'); }
      } catch (error) {
        if (active && error instanceof Error && error.message !== 'unauthorized') { setBootError(true); setNotice({ key: error.message, error: true }); }
      } finally { if (active) setBooting(false); }
      const error = new URLSearchParams(window.location.search).get('error');
      if (error && active) { setNotice({ key: error, error: true }); window.history.replaceState(null, '', path); }
    })();
    return () => { active = false; };
    // Initialize once; navigation must not overwrite the chosen language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    let active = true;
    void api<Catalog>(`catalog?locale=${locale}`).then(c => { if (active) setCatalog(c); }).catch(() => { if (active) setNotice({ key: 'unavailable', error: true }); });
    return () => { active = false; };
  }, [locale]);
  const userId = me?.id; const ready = me?.ready;
  useEffect(() => {
    if (!userId || (!(path === '/' && ready) && path !== '/likes' && !path.startsWith('/players/'))) return;
    let active = true;
    void (async () => {
      setLoading(true); setFeedError(false);
      try {
        if (path.startsWith('/players/')) {
          const result = await api<Detail>(`players/${path.split('/')[2]}`); if (active) setDetail(result);
        } else {
          const result = await api<{ players: Player[] }>(path === '/likes' ? 'likes' : 'discovery'); if (active) setPlayers(result.players);
        }
      } catch (error) { if (active) { setFeedError(true); setNotice({ key: error instanceof Error ? error.message : 'unavailable', error: true }); } }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [userId, ready, path, feedVersion]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 5000); return () => clearTimeout(timer);
  }, [notice]);
  const run: Run = async (task, success) => {
    if (busy) return false;
    setBusy(true); setNotice(null);
    try { await task(); if (success) setNotice({ key: success, error: false }); return true; }
    catch (error) { setNotice({ key: error instanceof Error ? error.message : 'unavailable', error: true }); return false; }
    finally { setBusy(false); }
  };
  const chooseLocale = (value: Locale) => {
    setLocale(value); localStorage.setItem('lockinder-locale', value);
    if (me) void api('settings', { locale: value }).catch(() => setNotice({ key: 'unavailable', error: true }));
  };
  const nav = [ { href: '/', label: 'discover', icon: Compass }, { href: '/likes', label: 'likes', icon: Heart }, { href: '/profile', label: 'profile', icon: UserRound }, { href: '/settings', label: 'settings', icon: MessageCircle } ];
  const action = async (target: string, kind: 'like' | 'pass') => {
    await run(async () => {
      await api(kind, { target });
      setPlayers(old => old.filter(p => p.id !== target));
      if (players.length <= 1) setFeedVersion(n => n + 1);
    }, kind === 'like' ? 'likeSent' : undefined);
  };
  const block = (target: string) => void run(async () => {
    await api('block', { target }); setPlayers(old => old.filter(p => p.id !== target));
    await refresh(); if (path.startsWith('/players/')) router.push('/'); else setFeedVersion(n => n + 1);
  }, 'blockDone');
  const updateSetting = (key: 'paused' | 'notifications', value: boolean) => void run(async () => {
    if (!me) return;
    const previous = me;
    setMe({ ...me, [key]: value });
    try { await api('settings', { [key]: value }); await refresh(); }
    catch (error) { setMe(previous); throw error; }
  });
  return <div className="app-shell">
    <header className="topbar"><Link href="/" className="brand" aria-label="Lockinder"><span className="brand-mark"><img src="/icon.svg" width="28" height="28" alt="" /></span>lockinder<span className="brand-dot">.</span></Link>
      <div className="top-actions">{me && <button className="mobile-logout" aria-label={t('logout')} disabled={busy} onClick={() => void run(async () => { await api('logout', {}); setMe(null); router.push('/'); })}><LogOut size={17} /></button>}<div className="locale" aria-label={t('languageLabel')}><Globe2 size={15} /><button aria-pressed={locale === 'en'} onClick={() => chooseLocale('en')}>EN</button><span>/</span><button aria-pressed={locale === 'ru'} onClick={() => chooseLocale('ru')}>RU</button></div>{me && <Link className="header-avatar" href="/profile"><Avatar player={me} /><span>{me.name}</span></Link>}</div>
    </header>
    {notice && <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{t(notice.key)}</span><button onClick={() => setNotice(null)} aria-label={t('close')}><X size={18} /></button></div>}
    {booting ? <Loading t={t} /> : bootError ? <Empty title={t('unavailable')} text=""><button className="primary" onClick={() => window.location.reload()}>{t('retry')}</button></Empty> : !me ? <Guest t={t} /> : <div className="workspace">
      <aside className="sidebar"><div className="sidebar-top"><nav>{nav.map(n => <Link key={n.href} href={n.href} className={path === n.href ? 'active' : ''}><n.icon size={20} /><span>{t(n.label)}</span>{path === n.href && <span className="nav-dot" />}</Link>)}</nav></div>
        <div className="sidebar-bottom"><button className="text-button" disabled={busy} onClick={() => void run(async () => { await api('logout', {}); setMe(null); router.push('/'); })}><LogOut size={16} />{t('logout')}</button></div>
      </aside>
      <main className="main-content">
        {path === '/' && !me.complete ? <><PageTitle title={t('setupTitle')} subtitle={t('setupSub')} eyebrow={t('setupBadge')} /><Steps me={me} t={t} /><ProfileForm me={me} locale={locale} catalog={catalog} t={t} busy={busy} run={run} refresh={refresh} /></> :
        path === '/' && me.paused ? <Empty title={t('pausedTitle')} text={t('pausedText')}><button className="primary" disabled={busy} onClick={() => void run(async () => { await api('settings', { paused: false }); await refresh(); })}>{t('resume')}<ArrowRight size={17} /></button></Empty> :
        path === '/' ? <><PageTitle title={t('discoveryTitle')} subtitle="" /><div className="discovery-layout"><section className="deck">{loading ? <Loading t={t} /> : feedError ? <Empty title={t('unavailable')} text=""><button className="secondary" onClick={() => { setNotice(null); setFeedVersion(n => n + 1); }}>{t('retry')}</button></Empty> : players[0] ? <PlayerCard key={players[0].id} player={players[0]} me={me} catalog={catalog} locale={locale} t={t} busy={busy} onAction={kind => void action(players[0].id, kind)} onBlock={() => block(players[0].id)} /> : <Empty title={t('emptyTitle')} text={t('emptyText')}><button className="secondary" disabled={busy} onClick={() => void run(async () => { await api('passes/reset', {}); setFeedVersion(n => n + 1); })}><RefreshCw size={16} />{t('reviewPassed')}</button></Empty>}</section><FilterPanel filters={me.filters} catalog={catalog} t={t} busy={busy} onSave={f => void run(async () => { await api('filters', f); await refresh(); setFeedVersion(n => n + 1); })} /></div></> :
        path === '/profile' ? <><PageTitle title={t('profile')} subtitle={t('editSub')} /><ProfileForm me={me} locale={locale} catalog={catalog} t={t} busy={busy} run={run} refresh={refresh} /></> :
        path === '/settings' ? <><PageTitle title={t('settings')} subtitle={t('discordSub')} /><DiscordPanel me={me} t={t} run={run} refresh={refresh} busy={busy} /><section className="panel settings-panel">{(['paused', 'notifications'] as const).map(key => <label className="toggle-row" key={key}><span><strong>{t(key === 'paused' ? 'pause' : 'notifications')}</strong><small>{t(key === 'paused' ? 'pauseHint' : 'notificationsHint')}</small></span><input type="checkbox" role="switch" checked={me[key]} disabled={busy} onChange={e => updateSetting(key, e.target.checked)} /></label>)}</section><section className="panel"><h2>{t('blockedPlayers')}</h2>{me.blocks.length ? me.blocks.map(p => <div className="blocked-row" key={p.id}><span>{p.name}</span><button className="text-button" disabled={busy} onClick={() => void run(async () => { await api('block', { target: p.id, remove: true }); await refresh(); })}>{t('unblock')}</button></div>) : <p className="muted">{t('noBlocks')}</p>}</section></> :
        path === '/likes' ? <><PageTitle title={t('likes')} subtitle={t('likesSub')} />{loading ? <Loading t={t} /> : feedError ? <Empty title={t('unavailable')} text=""><button className="secondary" onClick={() => { setNotice(null); setFeedVersion(n => n + 1); }}>{t('retry')}</button></Empty> : players.length ? <div className="likes-grid">{players.map(p => <Link className="like-card" href={`/players/${p.id}`} key={p.id}><Avatar player={p} large /><h2>{p.name}</h2><Rank player={p} catalog={catalog} t={t} /><p>{p.languages.map(l => language(l, locale)).join(' · ')}</p><span className="card-link">{t('viewProfile')}<ArrowRight size={17} /></span></Link>)}</div> : <Empty title={t('noLikes')} text={t('noLikesText')}><Link className="primary" href="/">{t('discover')}<ArrowRight size={17} /></Link></Empty>}</> :
        path.startsWith('/players/') ? <><Link className="back-link" href="/"><ArrowLeft size={16} />{t('back')}</Link>{loading ? <Loading t={t} /> : feedError || !detail ? <Empty title={t('profileUnavailable')} text="" /> : <div className="detail-layout"><PlayerCard player={detail} me={me} catalog={catalog} locale={locale} t={t} busy={busy} onBlock={() => block(detail.id)} /><section className="panel contact-panel"><MessageCircle size={30} /><h2>{t('connectLabel')}</h2><p>{t('contactHint')}</p>{detail.discordUsername && <><span className="discord-username">@{detail.discordUsername}</span><button className="secondary" onClick={() => void run(async () => { await navigator.clipboard.writeText(detail.discordUsername!); }, 'copied')}><Copy size={16} />{t('copyUsername')}</button></>}{detail.discordId && <a className="primary" href={`https://discord.com/users/${detail.discordId}`} target="_blank" rel="noreferrer">{t('connectDiscord')}<ExternalLink size={16} /></a>}{detail.steamUrl && <a className="secondary" href={detail.steamUrl} target="_blank" rel="noreferrer">{t('connectSteam')}<ExternalLink size={16} /></a>}</section></div>}</> : <Empty title={t('notFound')} text=""><Link className="primary" href="/">{t('back')}</Link></Empty>}
      </main>
    </div>}
    {path === '/' && <CommunityStats locale={locale} t={t} refreshKey={feedVersion} />}
    <footer><span>{t('unofficial')}</span></footer>
  </div>;
}

function CommunityStats({ locale, t, refreshKey }: { locale: Locale; t: T; refreshKey: number }) {
  const [stats, setStats] = useState<{ registeredPlayers: number; teammateConnections: number } | null>(null);
  useEffect(() => {
    let active = true;
    const update = () => { void api<{ registeredPlayers: number; teammateConnections: number }>('stats').then(data => { if (active) setStats(data); }).catch(() => { if (active) setStats(null); }); };
    update();
    const interval = setInterval(update, 60_000);
    return () => { active = false; clearInterval(interval); };
  }, [refreshKey]);
  return <dl className="community-stats" aria-label={t('communityStats')}>
    <div><dt>{t('registeredPlayers')}</dt><dd>{stats ? stats.registeredPlayers.toLocaleString(locale) : '—'}</dd></div>
    <div><dt>{t('teammateConnections')}<small>{t('connectionsExplanation')}</small></dt><dd>{stats ? stats.teammateConnections.toLocaleString(locale) : '—'}</dd></div>
  </dl>;
}
function PageTitle({ title, subtitle, eyebrow }: { title: string; subtitle: string; eyebrow?: string }) {
  return <div className="page-title">{eyebrow && <span className="eyebrow"><span className="live-dot" />{eyebrow}</span>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>;
}
function Guest({ t }: { t: T }) {

  return <main className="landing">
    <section className="recruitment">
      <div className="recruitment-body">
        <div className="recruitment-copy">
          <h1>{t('headline')}<span>{t('headlineGame')}</span></h1>
          <p>{t('subhead')}</p>
          <a href="/api/auth/steam" className="primary steam-button">{t('steamLogin')}<ArrowRight size={20} /></a>
          <small>{t('steamNote')}</small>
        </div>
        <div className="recruitment-art" aria-hidden="true"><span className="recruitment-watermark">DL</span><img className="guest-hero" src="/images/landing-character.png" alt="" /></div>
      </div>
    </section>
    <ol className="landing-guide">{['landingProfile', 'landingSearch', 'landingDiscord'].map((key, i) => <li key={key}><span className="guide-number">0{i + 1}</span><div><h2>{t(key)}</h2><p>{t(`${key}Text`)}</p></div></li>)}</ol>
  </main>;
}
function Steps({ me, t }: { me: Me; t: T }) {
  return <div className="steps">{[['stepProfile', me.complete], ['stepReady', me.ready]].map(([key, complete], i) => <div className={complete ? 'done' : ''} key={String(key)}><span>{complete ? <Check size={15} /> : `0${i + 1}`}</span>{t(String(key))}{i < 1 && <ChevronRight size={16} />}</div>)}</div>;
}
function PlayerCard({ player, me, catalog, locale, t, busy, onAction, onBlock }: { player: Player; me: Me; catalog: Catalog | null; locale: Locale; t: T; busy: boolean; onAction?: (kind: 'like' | 'pass') => void; onBlock: () => void }) {
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const heroList = catalog?.heroes.filter(h => player.heroes.includes(h.id)) || [];
  const shared = player.languages.some(l => me.languages.includes(l));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const stale = player.rankError || (player.rankFetchedAt && now - player.rankFetchedAt > 3600_000);
  return <div className="player-card" tabIndex={onAction ? 0 : undefined} aria-label={player.name}
    onKeyDown={e => { if (!onAction || busy || e.target !== e.currentTarget) return; if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onAction(e.key === 'ArrowLeft' ? 'pass' : 'like'); } }}
    onTouchStart={e => { touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
    onTouchEnd={e => { const start = touchStart.current; touchStart.current = null; if (!start || !onAction || busy) return; const dx = e.changedTouches[0].clientX - start.x; const dy = e.changedTouches[0].clientY - start.y; if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.5) onAction(dx > 0 ? 'like' : 'pass'); }}>
    <div className="player-cover">{heroList[0] ? <img src={heroList[0].portrait} alt={heroList[0].name} /> : <Gamepad2 className="cover-icon" size={150} />}<span className="cover-label">DEADLOCK / LOCKINDER</span><div className="cover-lines" /></div>
    <div className="player-body"><div className="identity-row"><Avatar player={player} large /><Rank player={player} catalog={catalog} t={t} /></div><h2>{player.name}</h2><div className="location"><Globe2 size={14} />{country(player.country, locale)}<span>·</span>{player.languages.map(l => language(l, locale)).join(', ')}</div><div className={`compatibility ${shared ? '' : 'neutral'}`}><UsersRound size={15} />{t(shared ? 'sharedLanguage' : 'otherLanguage')}</div>
      {player.bio && <div className="bio-section"><span className="eyebrow">{t('about')}</span><p>{player.bio}</p></div>}
      <span className="eyebrow">{t('roles')}</span><div className="chips">{player.roles.map(r => <span key={r}>{t(r)}</span>)}</div>
      {!!heroList.length && <><span className="eyebrow">{t('heroes')}</span><div className="hero-strip">{heroList.map(h => <div key={h.id} title={h.name}><img src={h.image} alt="" /><span>{h.name}</span></div>)}</div></>}
      <p className="rank-freshness">{stale && <span>{t('rankStale')} · </span>}{player.rankFetchedAt ? `${t('updated')} ${new Date(player.rankFetchedAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}` : t('unavailableRank')}<br />{t('rankSource')}</p>
    </div>
    {onAction && <div className="swipe-actions"><button className="pass-button" disabled={busy} onClick={() => onAction('pass')}><X size={22} />{t('pass')}</button><button className="like-button" disabled={busy} onClick={() => onAction('like')}><Heart size={21} />{t('like')}</button><p>{t('keyboardHint')}</p></div>}
    <button className="block-button" disabled={busy} onClick={onBlock}><Ban size={12} />{t('block')}</button>
  </div>;
}
function RankRange({ catalog, t, filters, disabled, onChange }: { catalog: Catalog | null; t: T; filters: Filters; disabled: boolean; onChange: (range: Pick<Filters, 'minRank' | 'maxRank'>) => void }) {
  const ranks = (catalog?.ranks ?? []).filter(r => r.tier > 0).flatMap(rank => rank.divisions.map(division => ({ ...rank, division, value: rankPosition(rank.tier, division)! }))).sort((a, b) => a.value - b.value);
  const first = ranks[0]?.value ?? 0, last = ranks.at(-1)?.value ?? 65;
  const low = Math.max(first, Math.min(filters.minRank ?? first, last));
  const high = Math.max(low, Math.min(filters.maxRank ?? last, last));
  const percent = (value: number) => (value - first) / (last - first || 1) * 100;
  const label = (value: number) => { const rank = ranks.find(r => r.value === value); return rank ? `${rank.name} ${['', 'I', 'II', 'III', 'IV', 'V', 'VI'][rank.division]}` : t('unavailableRank'); };
  return <fieldset className="rank-range"><legend>{t('rankRange')}</legend>
    <div className="rank-slider">
      <div className="rank-track"><div style={{ left: `${percent(low)}%`, right: `${100 - percent(high)}%` }} /></div>
      {(['minRank', 'maxRank'] as const).map((key, i) => {
        const value = i === 0 ? low : high, rank = ranks.find(r => r.value === value);
        return <div className="rank-slider-control" key={key}>
          <input type="range" aria-label={t(key)} aria-valuetext={label(value)} min={first} max={last} step={1} value={value} disabled={disabled || !ranks.length}
            style={{ clipPath: i === 0 ? `inset(0 calc(22px + (100% - 44px) * ${1 - (percent(low) + percent(high)) / 200}) 0 0)` : `inset(0 0 0 calc(22px + (100% - 44px) * ${(percent(low) + percent(high)) / 200}))` }}
            onChange={e => { const n = Number(e.target.value); const min = i === 0 ? Math.min(n, high) : low; const max = i === 1 ? Math.max(n, low) : high; onChange({ minRank: min === first ? null : min, maxRank: max === last ? null : max }); }} />
          <span className="rank-handle" style={{ left: `calc(22px + (100% - 44px) * ${percent(value) / 100})` }} aria-hidden="true">
            {rank && <img src={rank.image} alt="" />}<span>{rank ? ['', 'I', 'II', 'III', 'IV', 'V', 'VI'][rank.division] : '—'}</span>
          </span>
        </div>;
      })}
    </div>
    <div className="rank-range-labels"><span>{label(low)}</span><span>{label(high)}</span></div>
  </fieldset>;
}
function FilterPanel({ filters, catalog, t, busy, onSave }: { filters: Filters; catalog: Catalog | null; t: T; busy: boolean; onSave: (f: Filters) => void }) {
  const [draft, setDraft] = useState<Filters>(filters);
  const [expanded, setExpanded] = useState(false);
  return <aside className={`filter-panel panel ${expanded ? 'expanded' : ''}`}><button className="filter-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><SlidersHorizontal size={17} />{t('filters')}<span>{expanded ? '−' : '+'}</span></button><div className="filter-content"><h2>{t('filters')}</h2><form onSubmit={e => { e.preventDefault(); onSave(draft); }}><RankRange catalog={catalog} t={t} filters={draft} disabled={busy} onChange={range => setDraft({ ...draft, ...range })} /><fieldset><legend>{t('playstyles')}</legend><div className="role-options">{ROLES.map(r => <label key={r} className={draft.roles.includes(r) ? 'selected' : ''}><input type="checkbox" checked={draft.roles.includes(r)} onChange={e => setDraft({ ...draft, roles: e.target.checked ? [...draft.roles, r] : draft.roles.filter(v => v !== r) })} />{t(r)}{draft.roles.includes(r) && <Check size={14} />}</label>)}</div></fieldset><button className="primary full" disabled={busy}>{t('apply')}</button><button className="text-button full" type="button" disabled={busy} onClick={() => { const empty = { minRank: null, maxRank: null, roles: [] }; setDraft(empty); onSave(empty); }}>{t('reset')}</button></form></div></aside>;
}
function ProfileForm({ me, locale, catalog, t, busy, run, refresh }: { me: Me; locale: Locale; catalog: Catalog | null; t: T; busy: boolean; run: Run; refresh: () => Promise<void> }) {
  const [form, setForm] = useState({ name: me.name, country: me.country, languages: me.languages, roles: me.roles, heroes: me.heroes, bio: me.bio });
  const toggle = <T extends string | number,>(values: T[], v: T) => values.includes(v) ? values.filter(x => x !== v) : [...values, v];
  return <div className="profile-layout"><form className="panel profile-form" onSubmit={e => { e.preventDefault(); void run(async () => { await api('profile', form); await refresh(); }, 'saved'); }}>
    <div className="form-identity"><Avatar player={me} large /><div><h2>{me.name}</h2><span className="verified"><ShieldCheck size={14} />Steam</span></div></div>
    <div className="form-row"><label>{t('name')} *<input required minLength={2} maxLength={40} value={form.name} placeholder={t('namePlaceholder')} onChange={e => setForm({ ...form, name: e.target.value })} /></label><label>{t('country')} *<select required value={form.country} onChange={e => setForm({ ...form, country: e.target.value })}><option value="">{t('chooseCountry')}</option>{Object.entries(countries.getNames(locale)).sort((a, b) => a[1].localeCompare(b[1], locale)).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label></div>
    <fieldset><legend>{t('languages')} *</legend><div className="language-picker">{LANGUAGES.map(l => <button type="button" aria-pressed={form.languages.includes(l)} key={l} onClick={() => setForm({ ...form, languages: toggle(form.languages, l) })}>{language(l, locale)}{form.languages.includes(l) && <Check size={12} />}</button>)}</div></fieldset>
    <fieldset><legend>{t('playstyles')} *</legend><div className="select-chips">{ROLES.map(r => <button type="button" key={r} aria-pressed={form.roles.includes(r)} onClick={() => setForm({ ...form, roles: toggle(form.roles, r) })}>{t(r)}</button>)}</div></fieldset>
    <label>{t('bio')}<textarea rows={4} maxLength={600} placeholder={t('bioPlaceholder')} value={form.bio} onChange={e => setForm({ ...form, bio: e.target.value })} /><small className="char-count">{form.bio.length} / 600</small></label>
    <fieldset><legend>{t('heroes')}</legend><small>{t('heroHint')}</small>{catalog?.stale && <small>{t('catalogStale')}</small>}<div className="hero-picker">{catalog?.heroes.map(h => <button type="button" key={h.id} title={h.name} aria-pressed={form.heroes.includes(h.id)} disabled={!form.heroes.includes(h.id) && form.heroes.length >= 12} onClick={() => setForm({ ...form, heroes: toggle(form.heroes, h.id) })}><img src={h.image} alt="" /><span>{h.name}</span>{form.heroes.includes(h.id) && <Check size={15} />}</button>)}</div></fieldset>
    <div className="form-bottom"><small>{t('requiredHint')}</small><button className="primary" disabled={busy || !form.languages.length || !form.roles.length}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{t('saveProfile')}</button></div>
  </form><aside className="panel profile-aside"><span className="eyebrow">DEADLOCK</span><Rank player={me} catalog={catalog} t={t} /><p>{t('rankSource')}</p>{me.rankFetchedAt && <small>{t('updated')} {new Date(me.rankFetchedAt).toLocaleString(locale)}</small>}{me.rankError && <p className="warning-text">{t(me.rankError)}</p>}<button className="secondary" disabled={busy} onClick={() => void run(async () => { await api('rank/refresh', {}); await refresh(); })}><RefreshCw size={15} />{t('refreshRank')}</button>{me.complete && !me.discord?.ready && <Link className="primary" href="/settings">{t('linkDiscord')}<ArrowRight size={16} /></Link>}</aside></div>;
}

function DiscordPanel({ me, t, run, refresh, busy }: { me: Me; t: T; run: Run; refresh: () => Promise<void>; busy: boolean }) {
  return <section className="panel discord-panel"><div className="discord-heading"><span className="discord-icon"><MessageCircle size={28} /></span><div><h2>{t('discordTitle')}</h2><p>{t('discordSub')}</p></div></div>
    {!me.discordConfigured ? <p className="inline-warning">{t('configurationMissing')}</p> : <>
      {me.discord?.error && <div className="inline-warning" role="status">{t('repair')}<br />{t(me.discord.error)}</div>}
      <div className="discord-step"><span className={me.discord ? 'step-number done' : 'step-number'}>{me.discord ? <Check size={16} /> : '1'}</span><div><h3>{t('stepDiscord')}</h3>{me.discord ? <span className="discord-username">@{me.discord.username}</span> : <a className="discord-button" href="/api/auth/discord">{t('linkDiscord')}<ExternalLink size={15} /></a>}</div></div>
      <div className="discord-step"><span className="step-number">2</span><div><h3>{t('joinServer')}</h3><p>{t('joinHint')}</p>{me.discordInvite && /^https:\/\/(discord\.gg|discord\.com)\//.test(me.discordInvite) ? <a className="secondary" href={me.discordInvite} target="_blank" rel="noreferrer">{t('joinServer')}<ExternalLink size={15} /></a> : <small>{t('inviteMissing')}</small>}</div></div>
      <div className="discord-step"><span className={me.discord?.ready ? 'step-number done' : 'step-number'}>{me.discord?.ready ? <Check size={16} /> : '3'}</span><div><h3>{t(me.discord?.ready ? 'discordReady' : 'testDM')}</h3><p>{t(me.discord?.ready ? 'discordConnectedHint' : 'testHint')}</p><button className="primary" disabled={busy || !me.discord} onClick={() => void run(async () => { try { await api('discord/test', {}); } finally { await refresh(); } }, 'discordReady')}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}{t('testDM')}</button></div></div>
    </>}
    <div className="discord-bottom">{me.discord && <button className="text-button danger" disabled={busy} onClick={() => void run(async () => { await api('discord/disconnect', {}); await refresh(); })}>{t('disconnect')}</button>}{me.ready && <Link className="secondary" href="/">{t('startDiscovering')}<ArrowRight size={16} /></Link>}</div>
  </section>;
}
