(function () {
	'use strict';

	const ICON_ID = 'gtmvc-status';
	const TIP_ID = 'gtmvc-tip';
	const AUTOCLOSE_MS = 5 * 1000;

	const SVG_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
	const SVG_WARN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';

	const SVG_EXTERNAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';

	const SVG_RELOAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';

	// MUI CircularProgress 風のスピナー（3/4 円弧をリングとして描画し、CSS で回転させる）
	const SVG_SPINNER = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="42 100"/></svg>';

	let currentKey = null;
	let lastPublished = null;
	let lastState = 'loading';
	let lastData = {};
	let inFlight = false;

	let iconEl = null;
	let tipMode = 'hidden';
	let dismissedAbnormal = false;
	let hideTipTimer = null;
	let transientTimer = null;
	let rechecking = false;
	let republishError = null;
	let verifyTimer = null;

	function parseXssiJson(text) {
		return JSON.parse(text.replace(/^\)\]\}'[^\n]*\n?/, '').replace(/^\)\]\}',?\s*/, ''));
	}
	function deepFind(obj, targetKey, depth = 0) {
		if (!obj || typeof obj !== 'object' || depth > 8) return undefined;
		if (Object.prototype.hasOwnProperty.call(obj, targetKey)) return obj[targetKey];
		for (const k of Object.keys(obj)) {
			const found = deepFind(obj[k], targetKey, depth + 1);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	function parseIds(href) {

		const m = href.match(/accounts\/(\d+)\/containers\/(\d+)/);
		if (m) return { accountId: m[1], containerId: m[2] };

		const a = href.match(/[?&]accountId=(\d+)/);
		const c = href.match(/[?&]containerId=(\d+)/);
		if (a && c) return { accountId: a[1], containerId: c[1] };
		return null;
	}
	function fmtTime(d) {
		const p = (n) => String(n).padStart(2, '0');

		return `${d.getHours()}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	}

	function pickUsageContext(root) {
		const candidates = [
			root && root.data && root.data.usageContext,
			root && root.usageContext,
			root && root.properties && root.properties.usageContext,
		];
		for (const c of candidates) if (Array.isArray(c)) return c;
		return null;
	}
	async function fetchContainerInfo(accountId, containerId) {
		const url = `/api/accounts/${accountId}/containers/${containerId}?hl=ja`;
		const res = await fetch(url, { credentials: 'include' });
		if (!res.ok) throw new Error(`container API HTTP ${res.status}`);
		const json = parseXssiJson(await res.text());
		const root = json.default || json;
		const publicId =
			deepFind(root.properties, 'publicId') ||
			deepFind(root.data, 'publicId') ||
			deepFind(root, 'publicId');
		const publishedVersion = deepFind(root, 'publishedContainerVersionId');
		const usageContext = pickUsageContext(root);
		return {
			publicId: publicId || null,
			publishedVersion: publishedVersion != null ? String(publishedVersion) : null,
			usageContext,
		};
	}
	async function fetchServedVersion(publicId) {
		const url = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(publicId)}&t=${Date.now()}`;
		let res;
		try {
			res = await fetch(url, { cache: 'no-store' });
		} catch (e) {

			// gtm.js が 404 等で配信されていない場合、レスポンスに CORS ヘッダが付かず
			// CORS モードの fetch は TypeError で reject する（res.status では拾えない）。
			// ネットワーク障害も含め「取得不能＝未配信」の異常として扱う。
			const err = new Error('gtm.js を取得できませんでした（未配信の可能性）');
			err.notServed = true;
			throw err;
		}
		if (!res.ok) {
			const err = new Error('gtm.js HTTP ' + res.status);
			err.notServed = true;
			err.httpStatus = res.status;
			throw err;
		}
		const text = await res.text();
		const m = text.match(/"version":"(\d+)"/);
		return m ? m[1] : null;
	}

	// gtm.js の取得結果を3値に正規化する:
	//	 { served: '<num>' }				… 取得成功（バージョン取得）
	//	 { served: null }					 … 200 だがバージョン記述なし（gtm.js 非対象の可能性）
	//	 { notServed: true }				… 404/取得不能（＝異常検知の対象）
	//	 { error: <Error> }				 … その他の予期しないエラー
	async function fetchServedResult(publicId) {
		try {
			const served = await fetchServedVersion(publicId);
			return { served };
		} catch (e) {
			if (e && e.notServed) return { notServed: true, error: e };
			return { error: e };
		}
	}

	// info（コンテナ情報）と servedResult から表示ステータスを決定する共通ロジック。
	// runFullCheck と onReloadClick の分類差異（404 の扱い違い）を解消するために共用する。
	function classify(info, servedResult) {
		if (!info.publicId) {
			return { state: 'error', data: { message: 'publicId を取得できませんでした' } };
		}
		if (!isWebContainer(info.usageContext)) {
			return { state: 'skip' };
		}
		if (servedResult.notServed) {
			return {
				state: 'mismatch',
				data: {
					served: null, notServed: true,
					published: info.publishedVersion, publicId: info.publicId, checkedAt: new Date(),
				},
			};
		}
		if (servedResult.error) {
			return { state: 'error', data: { message: 'gtm.js の取得に失敗: ' + (servedResult.error.message || servedResult.error) } };
		}
		if (servedResult.served == null) {
			return { state: 'skip', data: { message: '配信中バージョンを取得できませんでした（gtm.js 非対象の可能性）' } };
		}
		const matched = info.publishedVersion != null && servedResult.served === info.publishedVersion;
		return {
			state: matched ? 'match' : 'mismatch',
			data: { served: servedResult.served, published: info.publishedVersion, publicId: info.publicId, checkedAt: new Date() },
		};
	}
	function isWebContainer(usageContext) {
		if (!usageContext) return true;
		return usageContext.includes(0);
	}

	function getCookie(name) {
		return document.cookie.split(';').map((c) => c.trim())
			.filter((c) => c.indexOf(name + '=') === 0)
			.map((c) => decodeURIComponent(c.slice(name.length + 1)))[0];
	}

	async function republishVersion(versionId) {
		const ids = parseIds(location.href);
		if (!ids) throw new Error('コンテナ配下ページではありません');
		const token = getCookie('GTM-XSRF-TOKEN');
		if (!token) throw new Error('XSRFトークンを取得できませんでした');
		const url = `/api/accounts/${ids.accountId}/containers/${ids.containerId}/versions/${versionId}/publish?hl=ja`;
		let res;
		try {
			res = await fetch(url, {
				method: 'POST',
				credentials: 'include',
				headers: {
					'Content-Type': 'application/json',
					'X-XSRF-TOKEN': token,
					'Accept': 'application/json',
				},
				body: '{}',
			});
		} catch (e) {
			throw new Error('通信に失敗しました');
		}
		if (!res.ok) throw new Error('公開 API エラー（HTTP ' + res.status + '）');

		// GTM 内部 API は失敗時も HTTP 200 を返し、本文の default.errorCode / errorMessage で
		// 結果を表す。errorCode が非0なら失敗（例: 7=権限なし）。
		let json = null;
		try { json = parseXssiJson(await res.text()); } catch (e) {}
		const root = (json && json.default) || json || {};
		if (root.errorCode) {
			const err = new Error(root.errorMessage || ('公開に失敗しました（コード ' + root.errorCode + '）'));
			err.errorCode = root.errorCode;
			throw err;
		}
		return true;
	}

	async function onRepublishClick(btn, versionId) {
		if (btn.__busy) return;
		btn.__busy = true;
		btn.disabled = true;
		btn.textContent = '再公開中…';
		republishError = null;
		try {
			await republishVersion(versionId);
			location.reload();
		} catch (e) {
			// 失敗内容（権限なし等）をツールチップ内に明示する
			republishError = '再公開に失敗しました：' + (e.message || '不明なエラー');
			const mode = (tipMode === 'hidden') ? 'persistent' : tipMode;
			showTip(mode);
		}
	}

	async function onReloadClick(btn) {
		if (rechecking) return;
		const ids = parseIds(location.href);
		if (!ids) return;
		rechecking = true;
		inFlight = true;
		republishError = null;
		// 手動再確認は明示操作なので即時に結果を表示する（自動判定の 2 秒ディレイは適用しない）。
		// 進行中の遅延再確認があれば破棄して結果の上書きを防ぐ。
		if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
		if (hideTipTimer) { clearTimeout(hideTipTimer); hideTipTimer = null; }
		if (btn) btn.classList.add('gtmvc-spin');
		try {

			// known な publicId があれば並列で先読みし、変わっていなければ再利用する
			const knownPublicId = (lastData && lastData.publicId) || null;
			const [info, servedByKnown] = await Promise.all([
				fetchContainerInfo(ids.accountId, ids.containerId),
				knownPublicId ? fetchServedResult(knownPublicId) : Promise.resolve(null),
			]);
			if (!parseIds(location.href)) return;

			let servedResult;
			if (!info.publicId || !isWebContainer(info.usageContext)) {
				servedResult = { served: null };
			} else if (knownPublicId === info.publicId && servedByKnown) {
				servedResult = servedByKnown;
			} else {
				servedResult = await fetchServedResult(info.publicId);
			}
			if (!parseIds(location.href)) return;
			lastPublished = info.publishedVersion;

			const c = classify(info, servedResult);
			lastState = c.state;
			lastData = c.data || {};

			applyStatus();

			const mode = (lastState === 'mismatch' || lastState === 'error')
				? 'persistent'
				: (tipMode === 'hidden' ? 'hover' : tipMode);
			showTip(mode);
		} catch (e) {

		} finally {
			rechecking = false;
			inFlight = false;
		}
	}

	// コンテナ詳細の「本体」が描画済みかを判定する。
	// 「バージョン」タブ等のトップナビ（#suite-top-nav 内の md-nav-bar）は SPA の遷移中に
	// 本体コンテンツより先に切り替わるため、URL やタブの有無だけを条件にすると、実画面が
	// まだコンテナ一覧のままの一瞬に Chip が表示されてしまう。
	// 本体は shrouter-view.gtm-ng-view（ルータービュー）に描画され、遷移が完了して初めて
	// コンテナ詳細用コンポーネント（gtm-draft-overview / gtm-container-version-list /
	// gtm-admin-overview 等）に切り替わる。逆に一覧・ホームでは gtm-account-list を表示する。
	// そこで「ルータービューが一覧(gtm-account-list)を表示しておらず、かつ空でない」ことを
	// コンテナ詳細 UI 描画済みの担保条件とする。
	function isContainerDetailReady() {
		const rv = document.querySelector('shrouter-view.gtm-ng-view');
		if (!rv) return false;
		if (!rv.firstElementChild) return false;			// 本体が描画途中（空）＝未確定
		if (rv.querySelector('gtm-account-list')) return false; // 本体がまだ一覧のまま
		return true;
	}

	function getTabList(ids) {
		const ul = document.querySelector('ul._md-nav-bar-list');
		if (!ul) return null;
		if (ids) {
			const sel = 'a[href*="containers/' + ids.containerId + '"], a[href*="containerId=' + ids.containerId + '"]';
			if (!ul.querySelector(sel)) return null;
		}
		// トップナビのタブだけでなく、コンテナ詳細の本体 UI が描画済みであることを担保する
		if (!isContainerDetailReady()) return null;
		return ul;
	}

	function buildStatusEl() {
		const el = document.createElement('div');
		el.id = ICON_ID;
		el.addEventListener('mouseenter', onEnter);
		el.addEventListener('mouseleave', onLeave);
		const ic = document.createElement('span');
		ic.className = 'gtmvc-status-icon';
		const tx = document.createElement('span');
		tx.className = 'gtmvc-status-text';
		el.appendChild(ic);
		el.appendChild(tx);
		return el;
	}

	function mountStatus(ul) {
		ul = ul || getTabList();
		if (!ul) return null;
		const nav = ul.parentElement;
		if (!nav) return null;
		if (!iconEl) iconEl = buildStatusEl();

		if (iconEl.parentElement !== nav || iconEl.previousElementSibling !== ul) {
			ul.insertAdjacentElement('afterend', iconEl);
		}

		if (!nav.__gtmvcFlex) {
			nav.__gtmvcFlex = true;
			nav.style.display = 'flex';
			nav.style.alignItems = 'center';
		}
		return iconEl;
	}

	function applyStatus(ul) {
		const el = mountStatus(ul);
		if (!el) return;
		const wantShow = (lastState === 'match' || lastState === 'mismatch' || lastState === 'error' || lastState === 'loading');

		if (el.__gtmvcState !== lastState) {
			el.__gtmvcState = lastState;
			if (wantShow) {
				const ic = el.querySelector('.gtmvc-status-icon');
				const tx = el.querySelector('.gtmvc-status-text');
				el.classList.remove('gtmvc-ok', 'gtmvc-warn', 'gtmvc-loading');
				if (lastState === 'match') {
					ic.innerHTML = SVG_CHECK;
					tx.textContent = '配信ステータス：正常';
					el.classList.add('gtmvc-ok');
				} else if (lastState === 'loading') {
					ic.innerHTML = SVG_SPINNER;
					tx.textContent = '配信ステータス：検証中...';
					el.classList.add('gtmvc-loading');
				} else {
					ic.innerHTML = SVG_WARN;
					tx.textContent = '配信ステータス：異常検知';
					el.classList.add('gtmvc-warn');
				}
			}
		}
		if (wantShow) showChip(el); else hideChip(el);
	}

	function showChip(el) {
		if (el.__hideTimer) { clearTimeout(el.__hideTimer); el.__hideTimer = null; }
		if (el.__shown) return;
		el.__shown = true;
		el.style.display = 'inline-flex';

		requestAnimationFrame(() => requestAnimationFrame(() => {
			if (el.__shown) el.classList.add('gtmvc-show');
		}));
	}

	function hideChip(el) {
		if (!el.__shown) { el.classList.remove('gtmvc-show'); el.style.display = 'none'; return; }
		el.__shown = false;
		el.classList.remove('gtmvc-show');
		if (el.__hideTimer) clearTimeout(el.__hideTimer);
		el.__hideTimer = setTimeout(() => { if (!el.__shown) el.style.display = 'none'; }, 200);
	}

	function hideStatus() {
		if (iconEl) hideChip(iconEl);
	}

	function ensureTip() {
		let t = document.getElementById(TIP_ID);
		if (!t) {
			t = document.createElement('div');
			t.id = TIP_ID;

			t.addEventListener('mouseenter', onTipEnter);
			t.addEventListener('mouseleave', onTipLeave);
			(document.body || document.documentElement).appendChild(t);
		}
		return t;
	}

	function onTipEnter() {
		if (hideTipTimer) { clearTimeout(hideTipTimer); hideTipTimer = null; }
	}
	function onTipLeave() {
		if (rechecking) return;
		if (tipMode === 'persistent' || tipMode === 'transient') return;
		if (hideTipTimer) clearTimeout(hideTipTimer);
		hideTipTimer = setTimeout(hideTooltip, 200);
	}

	function tipRow(label, value) {
		const row = document.createElement('div');
		row.className = 'gtmvc-tip-row';
		const l = document.createElement('span');
		l.className = 'gtmvc-tip-label';
		l.textContent = label;
		const v = document.createElement('span');
		v.className = 'gtmvc-tip-num';
		v.textContent = value;
		row.appendChild(l);
		row.appendChild(v);
		return row;
	}

	function buildTip(withClose) {
		const t = ensureTip();
		t.innerHTML = '';
		t.classList.toggle('has-close', !!withClose);

		t.classList.remove('gtmvc-ok', 'gtmvc-warn', 'gtmvc-neutral');
		if (lastState === 'match') t.classList.add('gtmvc-ok');
		else if (lastState === 'mismatch' || lastState === 'error') t.classList.add('gtmvc-warn');
		else t.classList.add('gtmvc-neutral');
		const d = lastData || {};

		const title = document.createElement('div');
		title.className = 'gtmvc-tip-title';
		if (lastState === 'match') { title.textContent = '公開中のバージョンは正常に配信されています'; }
		else if (lastState === 'mismatch' && d.notServed) { title.textContent = 'gtm.js が配信されていません（404）'; }
		else if (lastState === 'mismatch') { title.textContent = '公開中のバージョンが配信されていません！'; }
		else if (lastState === 'error') { title.textContent = 'バージョン取得エラー'; }
		else if (lastState === 'skip') { title.textContent = 'gtm.js 非対象'; }
		else { title.textContent = 'バージョン確認中…'; }
		t.appendChild(title);

		if (lastState === 'match' || lastState === 'mismatch') {

			t.appendChild(tipRow('公開中のバージョン：', d.published != null ? String(d.published) : '—'));

			const servedRow = document.createElement('div');
			servedRow.className = 'gtmvc-tip-row';
			const label = document.createElement('span');
			label.className = 'gtmvc-tip-label';
			const link = document.createElement('a');
			link.className = 'gtmvc-tip-link';
			link.target = '_blank';
			link.rel = 'noopener noreferrer';
			if (d.publicId) {
				link.href = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(d.publicId);
			}
			link.appendChild(document.createTextNode('配信中スクリプト'));
			const ext = document.createElement('span');
			ext.className = 'gtmvc-ext-icon';
			ext.innerHTML = SVG_EXTERNAL;
			link.appendChild(ext);
			link.addEventListener('click', (e) => { e.stopPropagation(); });
			label.appendChild(link);
			label.appendChild(document.createTextNode('のバージョン：'));
			const sval = document.createElement('span');
			sval.className = 'gtmvc-tip-num';
			sval.textContent = d.notServed ? '未配信（404）' : (d.served != null ? String(d.served) : '—');
			servedRow.appendChild(label);
			servedRow.appendChild(sval);
			t.appendChild(servedRow);
		}
		if (lastState === 'error') {
			const n = document.createElement('div');
			n.className = 'gtmvc-tip-note';
			n.textContent = d.message || '';
			t.appendChild(n);
		}
		if (lastState === 'skip') {
			const n = document.createElement('div');
			n.className = 'gtmvc-tip-note';
			n.textContent = d.message || 'ウェブ用以外のコンテナのため照合対象外です';
			t.appendChild(n);
		}

		if (lastState === 'mismatch' && d.published != null) {
			const rb = document.createElement('button');
			rb.className = 'gtmvc-tip-btn';
			rb.type = 'button';
			rb.textContent = 'バージョン' + d.published + 'を再公開';
			rb.addEventListener('click', (e) => {
				e.stopPropagation();
				onRepublishClick(rb, d.published);
			});
			t.appendChild(rb);
		}

		// 再公開の失敗内容（権限なし等）を明示（#2）
		if (republishError && (lastState === 'mismatch' || lastState === 'error')) {
			const en = document.createElement('div');
			en.className = 'gtmvc-tip-note gtmvc-tip-error';
			en.textContent = republishError;
			t.appendChild(en);
		}

		if (d.checkedAt) {
			const timeWrap = document.createElement('div');
			timeWrap.className = 'gtmvc-tip-time';
			const ts = document.createElement('span');
			ts.textContent = '最終確認：' + fmtTime(d.checkedAt);
			const reload = document.createElement('button');
			reload.className = 'gtmvc-tip-reload';
			reload.type = 'button';
			reload.title = 'gtm.js を再確認';
			reload.setAttribute('aria-label', 'gtm.js を再確認');
			reload.innerHTML = SVG_RELOAD;
			reload.addEventListener('click', (e) => { e.stopPropagation(); onReloadClick(reload); });
			timeWrap.appendChild(ts);
			timeWrap.appendChild(reload);
			t.appendChild(timeWrap);
		}

		if (withClose) {
			const btn = document.createElement('button');
			btn.className = 'gtmvc-tip-close';
			btn.type = 'button';
			btn.setAttribute('aria-label', '閉じる');
			btn.textContent = '×';
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				dismissedAbnormal = true;
				hideTooltip();
			});
			t.appendChild(btn);
		}
	}

	function anchorRect() {
		const el = (iconEl && iconEl.isConnected) ? iconEl : getTabList();
		return el ? el.getBoundingClientRect() : null;
	}

	function showTip(mode) {
		const withClose = (mode === 'persistent');
		buildTip(withClose);
		const t = ensureTip();

		const interactive = withClose || lastState === 'match' || lastState === 'mismatch';
		t.style.pointerEvents = interactive ? 'auto' : 'none';
		const r = anchorRect();
		if (r) {
			const tw = t.getBoundingClientRect().width;
			let left = r.left;
			if (left + tw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - tw);
			t.style.left = Math.round(left) + 'px';
			t.style.top = Math.round(r.bottom + 8) + 'px';
		} else {
			void t.offsetWidth;
		}
		t.classList.add('gtmvc-show');
		tipMode = mode;
	}

	function showTransient(ms) {
		if (transientTimer) { clearTimeout(transientTimer); transientTimer = null; }
		showTip('transient');
		transientTimer = setTimeout(() => {
			if (tipMode === 'transient') hideTooltip();
		}, ms);
	}

	function hideTooltip() {
		if (rechecking) return;
		const t = document.getElementById(TIP_ID);
		if (t) {
			t.classList.remove('gtmvc-show');
			t.style.pointerEvents = 'none';
		}
		if (transientTimer) { clearTimeout(transientTimer); transientTimer = null; }
		tipMode = 'hidden';
	}

	function onEnter() {
		if (hideTipTimer) { clearTimeout(hideTipTimer); hideTipTimer = null; }
		if (tipMode === 'persistent') return;
		if (lastState === 'loading') return;
		showTip('hover');
	}
	function onLeave() {
		if (rechecking) return;
		if (tipMode === 'persistent' || tipMode === 'transient') return;
		if (hideTipTimer) clearTimeout(hideTipTimer);
		hideTipTimer = setTimeout(hideTooltip, 200);
	}

	function render(state, data, opts) {
		opts = opts || {};
		// 新しい照合結果を反映する際は、前回クリック時の再公開エラー表示をクリアする
		republishError = null;
		lastState = state;
		lastData = data || {};
		applyStatus();

		const isAbn = (state === 'mismatch' || state === 'error');
		if (state === 'match') dismissedAbnormal = false;

		if (isAbn) {
			if (!dismissedAbnormal) {
				showTip('persistent');
			} else if (tipMode === 'hover') {
				showTip('hover');
			}
			return;
		}

		if (state === 'match') {
			if (opts.publishEvent) {
				showTransient(AUTOCLOSE_MS);
			} else if (tipMode === 'persistent') {
				hideTooltip();
			} else if (tipMode === 'hover' || tipMode === 'transient') {
				showTip(tipMode);
			}
			return;
		}

		if (tipMode === 'persistent') hideTooltip();
		else if (tipMode === 'hover') showTip('hover');
	}

	// 分類結果を UI に反映する。ただし mismatch（不一致・未配信）の場合は即時に異常検知を
	// 出さず、いったん「検証中…」を表示して 2 秒後に再確認し、それでも mismatch のときだけ
	// 異常検知を確定表示する。CDN 反映ラグ等による一時的な不一致での誤検知を避けるため。
	function applyResult(c, ids, opts) {
		opts = opts || {};
		if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
		if (c.state === 'mismatch') {
			render('loading');
			scheduleMismatchReverify(ids);
		} else {
			render(c.state, c.data, opts);
		}
	}

	function scheduleMismatchReverify(ids) {
		if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
		verifyTimer = setTimeout(async () => {
			verifyTimer = null;
			if (!parseIds(location.href)) return;
			try {
				const info = await fetchContainerInfo(ids.accountId, ids.containerId);
				if (!parseIds(location.href)) return;
				const servedResult = (info.publicId && isWebContainer(info.usageContext))
					? await fetchServedResult(info.publicId)
					: { served: null };
				if (!parseIds(location.href)) return;
				lastPublished = info.publishedVersion;
				const c = classify(info, servedResult);
				// 再確認の結果はそのまま確定表示する（mismatch でも再ループしない）
				render(c.state, c.data);
			} catch (e) {
				if (parseIds(location.href)) render('error', { message: String((e && e.message) || e) });
			}
		}, 2000);
	}

	async function runFullCheck(ids, force, preInfo) {
		if (inFlight) return;
		inFlight = true;
		try {
			const info = preInfo || await fetchContainerInfo(ids.accountId, ids.containerId);
			if (!parseIds(location.href)) return;

			const prevPublished = lastPublished;

			// publicId が無い/非対象コンテナは gtm.js を取得しない（classify 側で error/skip 判定）
			const servedResult = (info.publicId && isWebContainer(info.usageContext))
				? await fetchServedResult(info.publicId)
				: { served: null };
			if (!parseIds(location.href)) return;

			lastPublished = info.publishedVersion;
			const publishEvent = prevPublished != null && info.publishedVersion !== prevPublished;

			const c = classify(info, servedResult);
			applyResult(c, ids, { publishEvent: c.state === 'match' && publishEvent });
		} catch (e) {
			if (parseIds(location.href)) render('error', { message: String((e && e.message) || e) });
		} finally {
			inFlight = false;
		}
	}

	async function poll(ids) {
		if (document.hidden || inFlight) return;
		try {
			const info = await fetchContainerInfo(ids.accountId, ids.containerId);
			if (!parseIds(location.href)) return;
			if (info.publishedVersion !== lastPublished) {
				await runFullCheck(ids, false, info);
			}
		} catch (e) {	}
	}

	function onLocationChange() {
		const ids = parseIds(location.href);
		if (!ids) {
			if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
			currentKey = null;
			lastPublished = null;
			lastState = 'loading';
			dismissedAbnormal = false;
			hideStatus();
			hideTooltip();
			return;
		}
		const key = `${ids.accountId}/${ids.containerId}`;
		if (key !== currentKey) {
			if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
			currentKey = key;
			lastPublished = null;
			lastState = 'loading';
			dismissedAbnormal = false;
			hideTooltip();
			runFullCheck(ids, true);
		} else if (/\/versions\/\d+/.test(location.href)) {
			poll(ids);
		}
	}

	let lastHref = location.href;
	function pollLocation() {
		if (location.href !== lastHref) {
			lastHref = location.href;
			onLocationChange();
		}
	}

	function maintainUI() {
		const ids = parseIds(location.href);
		const ul = getTabList(ids);
		if (ids && ul) {
			applyStatus(ul);

			if (lastState === 'mismatch' || lastState === 'error') {
				if (!dismissedAbnormal && tipMode === 'hidden') showTip('persistent');
			}
		} else {
			hideStatus();
			hideTooltip();
		}
	}

	window.addEventListener('hashchange', onLocationChange);
	window.addEventListener('resize', () => { if (tipMode !== 'hidden') showTip(tipMode); });
	window.addEventListener('scroll', () => { if (tipMode !== 'hidden') showTip(tipMode); }, true);

	setInterval(() => { pollLocation(); maintainUI(); }, 1000);

	onLocationChange();
	maintainUI();
})();
