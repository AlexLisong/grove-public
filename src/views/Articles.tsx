import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, Check, FileText, Globe2, Plus, RefreshCw, Save, Send } from 'lucide-react';
import type { Entity } from '../../shared/types';
import type { ArticleApproval, ArticleListEntry, ArticlePublication, ArticleSite } from '../../shared/articles';
import { api, ApiError, post, safeUrl } from '../api';
import { useWorkspace } from '../store';
import { Badge, Button, Empty, ErrorNotice, Field, Input, Loading, Modal, PageHeader, SearchBox, TagsInput, timeAgo } from '../components/ui';
import { Markdown } from '../components/items';
import './articles.css';

type EditSelection = { entity?: Entity; copy?: Entity; publications: ArticlePublication[] };
type ArticleForm = { title: string; content: string; locale: 'en' | 'zh'; slug: string; excerpt: string; category: string; tags: string[]; siteIds: string[]; coverImage: string; date: string; featured: boolean };
type ArticleDraft = { version: number | null; draft: ArticleForm; savedAt: string };
const languageName = (locale: string) => locale === 'zh' ? '简体中文' : 'English';
const slugify = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
function articleForm(entity?: Entity): ArticleForm {
  const metadata = entity?.data.websiteArticle;
  return { title: entity?.title || '', content: entity?.content || '', locale: metadata?.locale === 'zh' || entity?.data.language === 'zh-CN' ? 'zh' : 'en', slug: metadata?.slug || slugify(entity?.title || ''), excerpt: metadata?.excerpt || '', category: metadata?.category || 'General', tags: entity?.tags || [], siteIds: metadata?.siteIds || [], coverImage: metadata?.coverImage || '', date: metadata?.date?.slice(0, 10) || '', featured: !!metadata?.featured };
}
function readArticleDraft(key: string): ArticleDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null'), draft = value?.draft;
    return value && (value.version === null || Number.isInteger(value.version) && value.version > 0) && typeof value.savedAt === 'string' && draft &&
      ['title', 'content', 'slug', 'excerpt', 'category', 'coverImage', 'date'].every(key => typeof draft[key] === 'string') &&
      ['en', 'zh'].includes(draft.locale) && typeof draft.featured === 'boolean' &&
      ['tags', 'siteIds'].every(key => Array.isArray(draft[key]) && draft[key].every((item: unknown) => typeof item === 'string')) ? value : null;
  } catch { return null; }
}

export function Articles() {
  const app = useWorkspace();
  const [articles, setArticles] = useState<ArticleListEntry[]>([]);
  const [sites, setSites] = useState<ArticleSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selection, setSelection] = useState<EditSelection | null>(null);
  const [copyId, setCopyId] = useState('');
  const refreshSequence = useRef(0);
  const canEdit = app.workspace.role !== 'viewer';
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const headers = { 'X-Workspace-Id': app.workspace.id };
    setError('');
    try {
      const [list, destinations] = await Promise.all([
        api<{ articles: ArticleListEntry[] }>('/articles', { headers }),
        api<{ sites: ArticleSite[] }>('/articles/sites', { headers }),
      ]);
      if (sequence !== refreshSequence.current) return;
      setArticles(list.articles); setSites(destinations.sites);
    } catch (e) { if (sequence === refreshSequence.current) setError((e as Error).message); }
    finally { if (sequence === refreshSequence.current) setLoading(false); }
  }, [app.workspace.id]);
  useEffect(() => { void refresh(); return () => { ++refreshSequence.current; }; }, [refresh]);
  const shown = articles.filter(({ entity, publications }) => {
    const matchesSite = filter === 'all' || entity.data.websiteArticle?.siteIds?.includes(filter) || publications.some(p => p.siteId === filter && p.status === 'published');
    return matchesSite && `${entity.title} ${entity.data.websiteArticle?.slug || ''}`.toLowerCase().includes(query.toLowerCase());
  });
  const copySources = app.entities.filter(e => e.kind === 'item' && e.data.type === 'document' && !e.data.websiteArticle && !e.archived);
  return <>
    <PageHeader eyebrow="FROM YOUR WORKSPACE TO YOUR READERS" title="Website articles" description="Write, review and publish to your websites in English or Chinese.">
      <Button onClick={() => void refresh()} aria-label="Refresh articles"><RefreshCw size={15} /></Button>
      {canEdit && <Button tone="primary" disabled={!sites.length} onClick={() => setSelection({ publications: [] })}><Plus size={16} />New article</Button>}
    </PageHeader>
    {error && <ErrorNotice onRetry={() => void refresh()}>{error}</ErrorNotice>}
    {loading ? <Loading label="Opening your articles…" /> : <>
      <div className="article-sites" aria-label="Publishing websites">
        {sites.map(site => <a key={site.id} href={`https://${site.domain}/en/blog`} target="_blank" rel="noopener noreferrer" className="article-site">
          <Globe2 size={19} /><div><strong>{site.name}</strong><span>{site.domain}</span></div><ArrowUpRight size={14} />
        </a>)}
      </div>
      {!sites.length ? <Empty icon={<Globe2 size={27} />} title="No websites connected" description="Your workspace host can connect a website for article publishing." /> : <>
        <div className="article-toolbar">
          <SearchBox value={query} onChange={setQuery} placeholder="Find an article…" />
          <select aria-label="Filter by website" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All websites</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select>
          {canEdit && <div className="article-copy"><select aria-label="Document to copy" value={copyId} onChange={e => setCopyId(e.target.value)}><option value="">Start from a document…</option>{copySources.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}</select><Button disabled={!copyId} onClick={() => { const copy = copySources.find(e => e.id === copyId); if (copy) setSelection({ copy, publications: [] }); }}><FileText size={14} />Use document</Button></div>}
        </div>
        {shown.length ? <div className="article-list">
          {shown.map(entry => { const { entity, publications } = entry; const live = publications.filter(p => p.status === 'published'); const changed = live.some(p => p.sourceVersion !== entity.version); return <article className="article-row" key={entity.id}>
            <button className="article-row-main" onClick={() => setSelection(entry)}><BookOpen size={22} /><div><h2>{entity.title}</h2><p>{entity.data.websiteArticle?.excerpt || 'Open this draft to add a description.'}</p><span>{languageName(entity.data.websiteArticle?.locale)} · {entity.data.websiteArticle?.category || 'General'} · Saved {timeAgo(entity.updatedAt)}</span></div></button>
            <div className="article-row-state"><Badge tone={live.length ? 'success' : ''}>{live.length ? changed ? 'Live · draft changed' : 'Live' : 'Draft'}</Badge><span>{live.length ? live.map(p => sites.find(s => s.id === p.siteId)?.name || p.siteId).join(', ') : 'Ready when you are'}</span><Button onClick={() => setSelection(entry)}>{canEdit ? 'Open article' : 'View article'}</Button></div>
          </article>; })}
        </div> : <Empty icon={<FileText size={27} />} title={query ? 'No matching articles' : 'Your next article starts here'} description={query ? 'Try another title or website.' : 'Create a draft or copy a document, select its websites, then review it before publishing.'} />}
      </>}
    </>}
    {selection && <ArticleEditor key={selection.entity?.id || selection.copy?.id || 'new'} selection={selection} sites={sites} canEdit={canEdit} onClose={() => setSelection(null)} onChanged={() => void refresh()} />}
  </>;
}

function ArticleEditor({ selection, sites, canEdit, onClose, onChanged }: { selection: EditSelection; sites: ArticleSite[]; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const app = useWorkspace();
  const initial = articleForm(selection.entity || selection.copy);
  const [entity, setEntity] = useState(selection.entity);
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [locale, setLocale] = useState(initial.locale);
  const [slug, setSlug] = useState(initial.slug);
  const [excerpt, setExcerpt] = useState(initial.excerpt);
  const [category, setCategory] = useState(initial.category);
  const [tags, setTags] = useState(initial.tags);
  const [siteIds, setSiteIds] = useState(initial.siteIds);
  const [coverImage, setCoverImage] = useState(initial.coverImage);
  const [date, setDate] = useState(initial.date);
  const [featured, setFeatured] = useState(initial.featured);
  const [publications, setPublications] = useState(selection.publications);
  const [approval, setApproval] = useState<ArticleApproval | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [withdraw, setWithdraw] = useState<(ArticlePublication & { operationId: string }) | null>(null);
  const [previewSiteId, setPreviewSiteId] = useState(initial.siteIds[0] || '');
  const [editVersion, setEditVersion] = useState<number | null>(entity?.version ?? null);
  const draftKey = `grove-article-draft:${app.workspace.id}:${app.session.user.id}:${entity ? `entity:${entity.id}` : selection.copy ? `copy:${selection.copy.id}` : 'new'}`;
  const [recovery, setRecovery] = useState(() => canEdit ? readArticleDraft(draftKey) : null);
  const [recoveryError, setRecoveryError] = useState('');
  const [conflictPending, setConflictPending] = useState(false);
  const [conflict, setConflict] = useState<ArticleListEntry | null>(null);
  const discarded = useRef(false);
  const form: ArticleForm = { title, content, locale, slug, excerpt, category, tags, siteIds, coverImage, date, featured };
  const signature = JSON.stringify(form);
  const [savedSignature, setSavedSignature] = useState(signature);
  const dirty = signature !== savedSignature || !entity;
  const hasLocalEdits = signature !== savedSignature;
  const blocked = !!recovery || conflictPending;
  const live = publications.filter(p => p.status === 'published');
  const previewSites = sites.filter(site => (approval && !dirty ? approval.destinations.map(d => d.siteId) : siteIds).includes(site.id));
  const previewSite = previewSites.find(site => site.id === previewSiteId) || previewSites[0];
  const previewArticleUrl = previewSite ? approval && !dirty ? approval.destinations.find(destination => destination.siteId === previewSite.id)?.url : `https://${previewSite.domain}/${locale}/blog/${encodeURIComponent(slug || 'your-article')}` : undefined;
  const previewCover = approval?.snapshot.coverImage || coverImage;
  const previewCoverUrl = previewCover.startsWith('/') && !previewCover.startsWith('//') ? previewSite ? safeUrl(`https://${previewSite.domain}${previewCover}`) : undefined : safeUrl(previewCover);
  const persistDraft = (reportError = true) => {
    if (recovery || !canEdit || discarded.current) return;
    try {
      if (hasLocalEdits) localStorage.setItem(draftKey, JSON.stringify({ version: editVersion, draft: form, savedAt: new Date().toISOString() }));
      else localStorage.removeItem(draftKey);
      if (reportError) setRecoveryError('');
    } catch { if (reportError) setRecoveryError('Local draft recovery is unavailable. Keep this article open until your changes are saved.'); }
  };
  const persistRef = useRef(persistDraft); persistRef.current = persistDraft;
  const unsavedRef = useRef(false); unsavedRef.current = hasLocalEdits && !recovery;
  function clearLocalDraft() {
    try { localStorage.removeItem(draftKey); setRecoveryError(''); }
    catch { setRecoveryError('The local recovery copy could not be removed from this browser.'); }
  }
  const close = () => {
    if (busy) return;
    if (!recovery && hasLocalEdits) {
      if (!window.confirm('Discard unsaved article changes?')) return;
      clearLocalDraft(); discarded.current = true;
    }
    onClose();
  };
  useEffect(() => { persistRef.current(); }, [signature, savedSignature, draftKey, editVersion, recovery]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (unsavedRef.current) { persistRef.current(); event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => { window.removeEventListener('beforeunload', guard); persistRef.current(false); };
  }, []);
  useEffect(() => { setApproval(null); }, [signature]);

  function applyForm(next: ArticleForm) {
    setTitle(next.title); setContent(next.content); setLocale(next.locale); setSlug(next.slug); setExcerpt(next.excerpt); setCategory(next.category);
    setTags(next.tags); setSiteIds(next.siteIds); setCoverImage(next.coverImage); setDate(next.date); setFeatured(next.featured);
  }
  function restoreDraft() {
    if (!recovery) return;
    applyForm(recovery.draft); setEditVersion(recovery.version); setRecovery(null); setApproval(null);
    if (entity && recovery.version !== entity.version) { setConflict({ entity, publications }); setConflictPending(true); }
  }
  async function loadSaved(): Promise<ArticleListEntry> {
    const result = await api<{ articles: ArticleListEntry[] }>('/articles', { headers: { 'X-Workspace-Id': app.workspace.id } });
    const latest = result.articles.find(entry => entry.entity.id === entity?.id);
    if (!latest) throw new Error('This article is no longer available. Your unsaved changes are still kept in this browser.');
    return latest;
  }
  function keepMyDraft() {
    if (!conflict) return;
    setEntity(conflict.entity); setEditVersion(conflict.entity.version); setSavedSignature(JSON.stringify(articleForm(conflict.entity)));
    setPublications(conflict.publications); setConflict(null); setConflictPending(false); setApproval(null); setWithdraw(null); setError('');
  }
  async function reloadSaved() {
    const latest = await loadSaved();
    if (hasLocalEdits && !window.confirm('Discard your unsaved changes and load the saved article?')) return;
    const next = articleForm(latest.entity);
    applyForm(next); setEntity(latest.entity); setEditVersion(latest.entity.version); setSavedSignature(JSON.stringify(next));
    setPublications(latest.publications); setRecovery(null); setConflict(null); setConflictPending(false); setApproval(null); setWithdraw(null); clearLocalDraft(); onChanged();
  }

  async function save() {
    if (blocked) throw new Error('Choose which draft to keep before saving or reviewing.');
    const websiteArticle = { locale, slug: slug.trim(), excerpt: excerpt.trim(), category: category.trim() || 'General', featured, siteIds, ...(coverImage.trim() ? { coverImage: coverImage.trim() } : {}), ...(date ? { date: `${date}T00:00:00.000Z` } : {}) };
    const { editorJSON: _editor, html: _html, ...previous } = entity?.data || {};
    const input = { title: title.trim(), content, tags, data: { ...previous, type: 'document', websiteArticle, ...(selection.copy && !entity ? { sourceIds: [selection.copy.id] } : {}) } };
    if (!input.title) throw new Error('Give your article a title.');
    const saved = entity ? await app.update(entity.id, { ...input, version: editVersion ?? entity.version }) : await app.create({ kind: 'item', visibility: 'private', ...input });
    clearLocalDraft(); setEntity(saved); setEditVersion(saved.version); setSavedSignature(signature); setApproval(null); onChanged();
    return saved;
  }
  async function perform(action: string, fn: () => Promise<void>) {
    setBusy(action); setError('');
    try { await fn(); } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 409 && entity) {
        setConflictPending(true); setConflict(null); setApproval(null);
        try { setConflict(await loadSaved()); }
        catch (loadError) { setError(`${(e as Error).message} ${(loadError as Error).message}`); }
      }
    }
    finally { setBusy(''); }
  }
  async function review() {
    const saved = dirty ? await save() : entity!;
    const response = await post<{ approval: ArticleApproval }>(`/articles/${saved.id}/approve`, { version: saved.version });
    setApproval(response.approval); setTab('preview');
  }
  async function publish() {
    if (!entity || !approval || dirty || blocked) return;
    const response = await post<{ publications: ArticlePublication[] }>(`/articles/${entity.id}/publish`, { version: approval.sourceVersion, approvalId: approval.id });
    setPublications(response.publications); setApproval(null); onChanged();
    app.notify('Article published to the selected websites.');
  }
  async function unpublish() {
    if (!entity || !withdraw) return;
    const response = await post<{ publications: ArticlePublication[] }>(`/articles/${entity.id}/unpublish`, { version: entity.version, siteIds: [withdraw.siteId], operationId: withdraw.operationId, expectedRevisions: { [withdraw.siteId]: withdraw.revision } });
    setPublications(response.publications); setWithdraw(null); setApproval(null); onChanged();
    app.notify('Article removed from this website. Your draft is saved.');
  }
  return <Modal wide title={entity ? 'Website article' : 'New website article'} onClose={close} footer={<>
    <span className="save-status">{recovery ? 'Local draft available' : dirty ? 'Unsaved draft' : 'Draft saved'}{live.length ? ` · Live on ${live.length} ${live.length === 1 ? 'website' : 'websites'}` : ''}</span><div className="spacer" />
    <Button disabled={!!busy} onClick={close}>Close</Button>
    {canEdit && <><Button disabled={!!busy || !dirty || blocked} busy={busy === 'save'} onClick={() => void perform('save', async () => { await save(); app.notify('Article draft saved.'); })}><Save size={14} />Save draft</Button><Button tone="primary" disabled={!!busy || blocked || !siteIds.length || !content.trim()} busy={busy === 'review'} onClick={() => void perform('review', review)}><BookOpen size={14} />Review for publishing</Button></>}
  </>}>
    {error && <ErrorNotice>{error}</ErrorNotice>}
    {recoveryError && <ErrorNotice>{recoveryError}</ErrorNotice>}
    {recovery && <section className="article-recovery" aria-label="Unsaved article recovery"><strong>Unsaved article changes are available</strong><p>This browser kept your changes when you left the editor. Restore them to continue, or discard the local copy.</p><details><summary>Review the local draft</summary><strong>{recovery.draft.title || 'Untitled article'}</strong><textarea aria-label="Local article draft" value={recovery.draft.content} readOnly rows={6} /></details><div><Button tone="primary" onClick={restoreDraft}>Restore draft</Button><Button onClick={() => { clearLocalDraft(); setRecovery(null); }}>Discard local draft</Button></div></section>}
    {conflictPending && <section className="article-recovery" aria-label="Article version conflict"><strong>The saved article changed</strong><p>Your draft is still here. Review the saved article, then choose which version to keep. Keeping your draft will replace the saved title, body and article details the next time you save.</p>{conflict ? <details><summary>Review the saved article</summary><strong>{conflict.entity.title}</strong><p>{languageName(conflict.entity.data.websiteArticle?.locale)} · {conflict.entity.data.websiteArticle?.slug}</p><textarea aria-label="Latest saved article content" value={conflict.entity.content} readOnly rows={6} /><pre>{JSON.stringify({ ...conflict.entity.data.websiteArticle, tags: conflict.entity.tags }, null, 2)}</pre></details> : <Button disabled={!!busy} onClick={() => void perform('load', async () => { setConflict(await loadSaved()); })}>Load saved version</Button>}<div><Button disabled={!!busy || !conflict} onClick={keepMyDraft}>Keep my draft</Button><Button disabled={!!busy} busy={busy === 'reload'} onClick={() => void perform('reload', reloadSaved)}>Reload saved article</Button></div></section>}
    <div className="website-article-editor">
      <div className="article-editor-top"><div><Badge>{languageName(locale)}</Badge>{live.length > 0 && <Badge tone="success">Published copy available</Badge>}</div><div className="segmented"><button className={tab === 'write' ? 'active' : ''} onClick={() => setTab('write')}>Write</button><button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Preview</button></div></div>
      {tab === 'write' ? <fieldset disabled={!canEdit || !!busy || !!recovery} className="article-fields">
        <Field label="Article title"><Input value={title} onChange={e => { const next = e.target.value; if (!slug || slug === slugify(title)) setSlug(slugify(next)); setTitle(next); }} maxLength={200} placeholder="What will your readers learn?" /></Field>
        <div className="article-form-grid"><Field label="Language"><select value={locale} onChange={e => setLocale(e.target.value as 'en' | 'zh')}><option value="en">English</option><option value="zh">简体中文</option></select></Field><Field label="URL slug" hint="Lowercase letters, numbers and hyphens."><Input value={slug} onChange={e => setSlug(e.target.value)} maxLength={100} placeholder="your-article-title" /></Field></div>
        <Field label="Description" hint="Shown in article lists and search results."><textarea value={excerpt} onChange={e => setExcerpt(e.target.value)} maxLength={600} rows={2} /></Field>
        <fieldset className="article-destinations"><legend>Publish to</legend>{sites.map(site => <label key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} onChange={e => setSiteIds(e.target.checked ? [...siteIds, site.id] : siteIds.filter(id => id !== site.id))} /><span><strong>{site.name}</strong><small>{site.domain}/{locale}/blog/{slug || 'your-article'}</small></span></label>)}</fieldset>
        <Field label="Article body" hint="Markdown supports headings, links, images, lists and code. Include public sources you want readers to see."><textarea className="article-body-input" value={content} onChange={e => setContent(e.target.value)} spellCheck placeholder="Start your article…" /></Field>
        <details className="article-options"><summary>Article details</summary><div className="article-form-grid"><Field label="Category"><Input value={category} onChange={e => setCategory(e.target.value)} maxLength={80} /></Field><Field label="Publication date" hint="Leave empty to use the draft's creation date."><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field></div><Field label="Tags"><TagsInput value={tags} onChange={setTags} /></Field><Field label="Cover image URL" hint="Use a permanent public image URL or an image already hosted on the websites."><Input value={coverImage} onChange={e => setCoverImage(e.target.value)} placeholder="https://…" /></Field><label className="article-featured"><input type="checkbox" checked={featured} onChange={e => setFeatured(e.target.checked)} />Feature this article. It replaces the current featured article for this language on the selected websites.</label></details>
      </fieldset> : <div className="article-preview">
        {approval && !dirty ? <div className="article-review-banner"><div><Check size={19} /><strong>Review this saved version before publishing</strong><p>Readers will see it on {approval.destinations.map(d => sites.find(s => s.id === d.siteId)?.name || d.siteId).join(', ')}.</p></div><Button tone="primary" disabled={!!busy || blocked} busy={busy === 'publish'} onClick={() => void perform('publish', publish)}><Send size={14} />Publish to {approval.destinations.length} {approval.destinations.length === 1 ? 'website' : 'websites'}</Button></div> : <p className="article-preview-note">This is your draft preview. Choose “Review for publishing” to prepare the saved version.</p>}
        {previewSites.length > 1 && <Field label="Preview website"><select value={previewSite?.id} onChange={e => setPreviewSiteId(e.target.value)}>{previewSites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></Field>}
        <span className="tiny-label">{approval?.snapshot.category || category}</span><h1>{approval?.snapshot.title || title || 'Your article title'}</h1><p className="article-preview-excerpt">{approval?.snapshot.excerpt || excerpt}</p>
        {previewCoverUrl && <img className="article-preview-cover" src={previewCoverUrl} alt="Article cover" />}
        {previewCover && !previewCoverUrl && <p className="article-preview-note">Select a website and use a public image URL to preview the cover.</p>}
        <Markdown baseUrl={previewArticleUrl}>{approval?.snapshot.content || content || 'Your article preview will appear here.'}</Markdown>
      </div>}
      {live.length > 0 && <section className="article-live-versions"><h3>Published on your websites</h3><p>Your saved draft can change while readers continue seeing the last published version.</p>{live.map(p => <div key={`${p.siteId}:${p.locale}:${p.slug}`}><a href={safeUrl(p.url)} target="_blank" rel="noopener noreferrer">{sites.find(s => s.id === p.siteId)?.name || p.siteId}<span>{p.locale}/blog/{p.slug}</span><ArrowUpRight size={14} /></a>{canEdit && <Button tone="ghost" disabled={!!busy || blocked} onClick={() => setWithdraw({ ...p, operationId: crypto.randomUUID() })}>Unpublish</Button>}</div>)}</section>}
      {withdraw && <div className="article-withdraw"><strong>Remove this article from {sites.find(s => s.id === withdraw.siteId)?.domain || withdraw.siteId}?</strong><p>It will leave the public article list and URL. Your draft remains in Grove.</p><div><Button disabled={!!busy} onClick={() => setWithdraw(null)}>Keep published</Button><Button tone="danger" busy={busy === 'unpublish'} disabled={!!busy} onClick={() => void perform('unpublish', unpublish)}>Unpublish from this website</Button></div></div>}
    </div>
  </Modal>;
}
