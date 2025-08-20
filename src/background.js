'use strict';

const state = {
	cookieStatus: true,
	cookieStr: '', //用于校验相同cookie
	cookieMap: null, //存储cookie的domain映射
	autoCompleteStatus: true,
	superCookieList: [], //cookie超级强制替换
}

// 使用 debugger 方案所需的附加状态
const attachedTabs = new Set()
let debuggerEventsBound = false

// 延迟初始化，等待 SW 冷启动完成
init()

function init() {
	console.log('chrome-cookie-issue is powered by chirpmonster')
	//获取第一次cookie
	updateCookie()
	//添加开关监听器
	addMessageListener()
	//添加请求监听器（MV3 下对 Cookie 头无效，仅保留以兼容老逻辑开关）
	addRequestListener()
	// 监听 cookie 变化，保持缓存最新
	if (chrome.cookies && chrome.cookies.onChanged) {
		chrome.cookies.onChanged.addListener(() => {
			updateCookie()
		})
	}
	// 周期性保活/刷新，避免 SW 回收后状态过旧
	if (chrome.alarms) {
		chrome.alarms.create('refreshCookies', { periodInMinutes: 5 })
		chrome.alarms.onAlarm.addListener((alarm) => {
			if (alarm.name === 'refreshCookies') {
				updateCookie()
			}
		})
	}
	chrome.storage.local.set({superCookieList: ''});
	chrome.storage.local.get(['superCookieList'], (result) => {
		if (!result.superCookieList) {
			let defaultList = ['localhost', '.baidu.com', 'www.baidu.com']
			chrome.storage.local.set({superCookieList: defaultList});
			state.superCookieList = defaultList
		} else {
			state.superCookieList = result.superCookieList || []
		}
	});

	// 绑定 debugger 事件，仅绑定一次
	bindDebuggerEventsOnce()
	// 根据当前开关尝试对现有标签页附加调试
	if (state.cookieStatus) {
		attachDebuggerToAllOpenTabs()
	}

	// 新标签页/更新时自动附加
	chrome.tabs && chrome.tabs.onCreated && chrome.tabs.onCreated.addListener((tab) => {
		if (!state.cookieStatus || !tab?.id) return
		attachDebuggerSafely(tab.id)
	})
	chrome.tabs && chrome.tabs.onUpdated && chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
		if (!state.cookieStatus) return
		if (changeInfo.status === 'loading') {
			attachDebuggerSafely(tabId)
		}
	})
}

function updateCookie() {
	chrome.cookies.getAll(
		{},
		(cookie) => {
			storeCookie(cookie)
		},
	)
}

function storeCookie(cookie) {
	//cookie更新校验
	if (state.cookieStr === JSON.stringify(cookie)) {
		console.log('cookie缓存未更新')
		return
	}
	state.cookieStr = JSON.stringify(cookie)
	const newCookieMap = new Map()
	//解析domain
	cookie.forEach((item) => {
		const str = (newCookieMap.get(item.domain) || '') + item.name + '=' + item.value + '; '
		newCookieMap.set(item.domain, str)
	})
	state.cookieMap = newCookieMap
	console.log('cookie缓存已更新')
	console.log(cookie)
}

function addMessageListener() {
	chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
		if (request.type === 'cookieStatus') {
			if (request.cookieStatus === true || request.cookieStatus === false) {
				const turningOn = request.cookieStatus === true && state.cookieStatus === false
				const turningOff = request.cookieStatus === false && state.cookieStatus === true
				state.cookieStatus = request.cookieStatus
				updateCookie()
				if (turningOn) {
					attachDebuggerToAllOpenTabs()
				}
				if (turningOff) {
					detachDebuggerFromAllTabs()
				}
			}
			if (request.superCookieList) {
				state.superCookieList = request.superCookieList
				chrome.storage.local.set({superCookieList: request.superCookieList});
			}
			sendResponse({
				success: true,
				cookieStatus: state.cookieStatus
			})
			return true
		}
		if (request.type === 'autoCompleteStatus') {
			if (request.autoCompleteStatus === true || request.autoCompleteStatus === false) {
				state.autoCompleteStatus = request.autoCompleteStatus
			}
			sendResponse({
				success: true,
				autoCompleteStatus: state.autoCompleteStatus
			})
			return true
		}
	});
}

function addRequestListener() {
	try {
		chrome.webRequest.onBeforeSendHeaders.removeListener(setCookie)
	} catch (e) {}
	chrome.webRequest.onBeforeSendHeaders.addListener(
		setCookie,
		{urls: ["<all_urls>"]},
		["blocking", "requestHeaders", "extraHeaders"]
	);
}

function setCookie(details) {
	if (!state.cookieStatus) {
		return
	}
	// 在 MV3 中不会生效，debugger 方案会真正改写；此处仅保留日志与逻辑一致性
	updateCookie()
	//网盘和谷歌商城存在验证问题
	let forbiddenList = ['baidu', 'google', 'gitlab', 'mfp', 'mail.qq', 'csdn', 'cnblogs']
	for (let i = 0; i < state.superCookieList.length; i++) {
		if (details.url?.includes(state.superCookieList[i])) {
			let newCookie = state.cookieMap?.get(state.superCookieList[i])
			if (!newCookie) {
				newCookie = state.cookieMap?.get('/')
			}
			if (newCookie) {
				details.requestHeaders.push({name: 'Cookie', value: newCookie})
				console.log('强制携带cookie成功:' + details.url + ' cookie为' + newCookie)
				return {requestHeaders: details.requestHeaders}
			}
			return
		}
	}
	for (let i = 0; i < forbiddenList.length; i++) {
		if (details.url?.includes(forbiddenList[i])) {
			return
		}
	}
	//如果已经有cookie，return
	for (let i = details.requestHeaders.length - 1; i >= 0; i--) {
		if (details.requestHeaders[i].name === 'Cookie') {
			console.log('无需添加cookie:' + details.url)
			return
		}
	}
	const url_to_domain_reg = /:\/\/.*?\//i
	const domain_to_subdomain_reg = /\.([a-z0-9-])+\.[a-z]+(:[0-9]*)?/g
	if (!details.url) {
		console.log(details + '本次未成功携带Cookie，请确认该请求是否需要携带Cookie' + details.url)
		console.log('若需要，请联系@chirpmonster')
		return
	}
	let domain = details.url.match(url_to_domain_reg)?.[0] ?? details.url //正则获取domain或者保底
	if (domain.match(domain_to_subdomain_reg)) {
		domain = domain.match(domain_to_subdomain_reg)
		domain = domain?.[0]?.split(':')?.[0]
	} else {
		if (domain.slice(0, 3) === '://') {
			domain = domain.substring(3)
		}
		if (domain[domain.length - 1] === '/') {
			domain = domain.split(':')?.[0]?.split('/')?.[0]
		}
	}
	let newCookie = state.cookieMap?.get(domain)
	//如果cookie不存在
	if (!newCookie) {
		newCookie = state.cookieMap?.get('/')
	}
	if (newCookie) {
		details.requestHeaders.push({name: 'Cookie', value: newCookie})
		console.log('成功携带cookie:' + details.url + ' cookie为' + newCookie)
		return {requestHeaders: details.requestHeaders}
	}
}

// ===== debugger 方案实现 =====
function bindDebuggerEventsOnce() {
	if (debuggerEventsBound) return
	debuggerEventsBound = true
	chrome.debugger.onEvent.addListener((source, method, params) => {
		if (!attachedTabs.has(source.tabId)) return
		if (method !== 'Fetch.requestPaused') return
		if (!state.cookieStatus) {
			// 关闭时直接放行
			chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: params.requestId })
			return
		}
		const url = params.request?.url
		if (!url) {
			chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: params.requestId })
			return
		}
		const headersObj = params.request?.headers || {}
		// 已有 Cookie 则不改
		for (const key in headersObj) {
			if (key.toLowerCase() === 'cookie' && headersObj[key]) {
				chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: params.requestId })
				return
			}
		}
		const newCookie = computeCookieForUrl(url)
		if (!newCookie) {
			chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: params.requestId })
			return
		}
		// 追加 Cookie 头
		const newHeaders = []
		for (const key in headersObj) {
			newHeaders.push({ name: key, value: String(headersObj[key]) })
		}
		newHeaders.push({ name: 'Cookie', value: newCookie })
		chrome.debugger.sendCommand(source, 'Fetch.continueRequest', {
			requestId: params.requestId,
			headers: newHeaders
		})
	})
	chrome.debugger.onDetach.addListener((source) => {
		attachedTabs.delete(source.tabId)
	})
}

function computeCookieForUrl(url) {
	updateCookie()
	let forbiddenList = ['baidu', 'google', 'gitlab', 'mfp', 'mail.qq', 'csdn', 'cnblogs']
	for (let i = 0; i < state.superCookieList.length; i++) {
		if (url?.includes(state.superCookieList[i])) {
			let forceCookie = state.cookieMap?.get(state.superCookieList[i]) || state.cookieMap?.get('/')
			return forceCookie || ''
		}
	}
	for (let i = 0; i < forbiddenList.length; i++) {
		if (url?.includes(forbiddenList[i])) {
			return ''
		}
	}
	const url_to_domain_reg = /:\/\/.*?\//i
	const domain_to_subdomain_reg = /\.([a-z0-9-])+\.[a-z]+(:[0-9]*)?/g
	let domain = url.match(url_to_domain_reg)?.[0] ?? url
	if (domain.match(domain_to_subdomain_reg)) {
		domain = domain.match(domain_to_subdomain_reg)
		domain = domain?.[0]?.split(':')?.[0]
	} else {
		if (domain.slice(0, 3) === '://') {
			domain = domain.substring(3)
		}
		if (domain[domain.length - 1] === '/') {
			domain = domain.split(':')?.[0]?.split('/')?.[0]
		}
	}
	let newCookie = state.cookieMap?.get(domain) || state.cookieMap?.get('/')
	return newCookie || ''
}

function attachDebuggerToAllOpenTabs() {
	if (!chrome.tabs || !chrome.debugger) return
	chrome.tabs.query({}, (tabs) => {
		if (!Array.isArray(tabs)) return
		tabs.forEach((tab) => {
			if (tab?.id) attachDebuggerSafely(tab.id)
		})
	})
}

function detachDebuggerFromAllTabs() {
	if (!chrome.debugger) return
	attachedTabs.forEach((tabId) => {
		try {
			chrome.debugger.detach({ tabId })
		} catch (e) {}
	})
	attachedTabs.clear()
}

function attachDebuggerSafely(tabId) {
	if (!state.cookieStatus) return
	if (attachedTabs.has(tabId)) return
	const target = { tabId }
	try {
		chrome.debugger.attach(target, '1.3', () => {
			if (chrome.runtime.lastError) {
				return
			}
			attachedTabs.add(tabId)
			// 拦截所有请求阶段
			chrome.debugger.sendCommand(target, 'Fetch.enable', {
				patterns: [{ urlPattern: '*' }]
			})
		})
	} catch (e) {}
}