// ==UserScript==
// @name         （github）学习通自动刷课脚本 V3 稳定版（roy v2）
// @namespace    local.codex.xuexitong
// @version      3.3.2
// @description  按原版框架自动播放、自动下一节、章节测验自动跳过；V3.3 兼容顺序解锁课程（等待解锁+跳转验证+兜底重试）
// @author       Codex
// @match        *://mooc1.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc2-ans/mycourse/studentstudy*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    if (typeof window.jQuery === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://code.jquery.com/jquery-3.6.0.min.js';
        script.type = 'text/javascript';
        script.onload = function () {
            console.log('jQuery loaded.');
            initializePlayer();
        };
        document.head.appendChild(script);
    } else {
        initializePlayer();
    }

    function initializePlayer() {
        window.app = {
            VERSION: '3.3.2',
            configs: {
                playbackRate: 2,
                autoplay: true,
                retryInterval: 2000,
                maxRetries: 10,
                videoCheckInterval: 1000,
                guardNoProgressMs: 7000,
                guardResumeCooldownMs: 1500,
                // ---- V3.3 跳转流程配置 ----
                unlockWaitIntervalMs: 1000,  // 等待下一小节在目录中解锁/渲染的轮询间隔
                unlockWaitMaxMs: 15000,      // 等待解锁的总上限（顺序解锁课程侧边栏刷新约需10秒）
                verifyIntervalMs: 1000,      // 点击后验证页面是否真的跳转的轮询间隔
                verifyMaxMs: 8000,           // 每次点击后的验证窗口
                clickRetryTimes: 3,          // 点击目标节点的最大尝试次数
                clickRetryGapMs: 1500,       // 两次点击尝试之间的间隔
                navFailRetryTimes: 3,        // 整个跳转流程的最大重试轮数
                navFailRetryGapMs: 5000,     // 跳转流程重试间隔
                loadGraceMs: 6000,           // 跳转成功后等待新内容加载的宽限期（期间不点页签/下一节）
            },
            _videoEl: null,
            _treeContainerEl: null,
            _isPlaying: false,
            _checkInterval: null,
            _switching: false,          // 跳转流程（等待/点击/验证）进行中，封锁一切播放入口
            _navFailCount: 0,           // 跳转流程连续失败轮数
            _loadGraceUntil: 0,         // 跳转成功后新内容加载宽限期截止时间戳
            _navBaseline: null,         // 跳转前的内容身份快照（用于识别“假成功”）
            _lastCellSummary: '',
            _boundVideoHandlers: null,
            _cellData: {
                cells: 0,
                nCells: 0,
                currentCellIndex: 0,
                currentNCellIndex: 0,
                currentVideoTitle: '',
            },
            run() {
                console.log('%c=== 学习通自动刷课脚本 V3.3.2 稳定版（roy v2）启动 ===', 'color:#4CAF50;font-size:16px;font-weight:bold');

                // 先拿到容器，如果容器都不存在直接报错（和原来一样）
                this._getTreeContainer();

                // 如果课程列表已经加载好了，直接初始化
                if (this._treeContainerEl.find('li').length > 0) {
                    this._continueAfterInit();
                } else {
                    // 否则等 DOM 变动，直到列表项出现
                    console.log('%c等待课程列表加载...', 'color:#FF9800');
                    const observer = new MutationObserver((mutations, obs) => {
                        if (this._treeContainerEl.find('li').length > 0) {
                            obs.disconnect();
                            this._continueAfterInit();
                        }
                    });
                    observer.observe(this._treeContainerEl[0], {
                        childList: true,
                        subtree: true
                    });
                    // 设置一个超时兜底，防止一直等不到
                    setTimeout(() => {
                        observer.disconnect();
                        if (this._cellData.cells === 0) {
                            console.warn('课程列表加载超时，强制初始化');
                            this._continueAfterInit();
                        }
                    }, 10000);
                }
            },

            // 把原来 run() 中初始化之后的部分抽取出来
            _continueAfterInit() {
                this._initCellData();
                this._clearCheckInterval();
                this._bindStepNavigation();
                this.play();
            },

            // ==================== V3.3 跳转流程 ====================
            // 总入口：带防重入保护，ended事件与轮询双路径触发时只放行一个
            nextUnit() {
                if (this._switching) {
                    console.log('%c[nextUnit] 跳转流程进行中，忽略重复触发', 'color:#607D8B');
                    return;
                }
                console.log('%c=== 准备切换到下一小节 ===', 'color:#2196F3;font-size:14px');
                this._navBaseline = this._captureContentIdentity();
                this._switching = true;
                this._navigateToNext().catch((e) => {
                    console.error('跳转流程异常:', e);
                    this._onNavigateFailure('异常: ' + (e && e.message));
                });
            },

            async _navigateToNext() {
                // 1) 等待目标节点在目录中出现（顺序解锁课程在侧边栏刷新前拿不到下一节点）
                const acquired = await this._acquireTarget();
                if (acquired.done) {
                    console.log('%c=====================================', 'color:#4CAF50;font-size:16px');
                    console.log('%c==============本课程学习完成了==============', 'color:#4CAF50;font-size:16px;font-weight:bold');
                    console.log('%c=====================================', 'color:#4CAF50;font-size:16px');
                    this._clearCheckInterval();
                    this._switching = false;
                    return;
                }
                const target = acquired.target;

                // 2) 点击目标节点并验证页面是否真的跳转（失败自动重试）
                if (target && await this._clickAndVerify(target)) {
                    await this._onNavigateSuccess();
                    return;
                }

                // 3) 兜底：点击网站自带的“下一节”按钮
                if (await this._fallbackNextButton()) {
                    await this._onNavigateSuccess();
                    return;
                }

                this._onNavigateFailure(target ? '点击目标节点未能跳转' : '等待下一小节解锁超时');
            },

            // 计算下一个目标：同章节的下一小节，否则下一章的第一小节；返回 null 表示课程已完成
            _computeNextTarget() {
                const cells = this._getTreeContainer().children('ul').children('li');
                const curCell = this._cellData.currentCellIndex;
                const curN = this._cellData.currentNCellIndex;
                const nCells = $(cells.get(curCell)).find('.posCatalog_select:not(.firstLayer)');

                if (nCells.length > curN + 1) {
                    return { cellIndex: curCell, nodeIndex: curN + 1 };
                }
                const nextCell = curCell + 1;
                if (nextCell >= cells.length) {
                    return null;
                }
                return { cellIndex: nextCell, nodeIndex: 0 };
            },

            _getTargetNode(target) {
                try {
                    const cells = this._getTreeContainer().children('ul').children('li');
                    if (target.cellIndex >= cells.length) return null;
                    const nCells = $(cells.get(target.cellIndex)).find('.posCatalog_select:not(.firstLayer)');
                    return nCells.get(target.nodeIndex) || null;
                } catch (e) {
                    return null;
                }
            },

            // 轮询等待：目录渲染好 + 激活节点可定位 + 目标节点出现（解锁）
            async _acquireTarget() {
                const deadline = Date.now() + this.configs.unlockWaitMaxMs;
                while (true) {
                    let foundCurrent = false;
                    try {
                        foundCurrent = this._initCellData();
                    } catch (e) {}

                    if (foundCurrent) {
                        const target = this._computeNextTarget();
                        if (target === null) {
                            return { done: true };
                        }
                        if (this._getTargetNode(target)) {
                            return { target };
                        }
                        console.log(`%c下一小节（第${target.cellIndex + 1}章 第${target.nodeIndex + 1}节）尚未出现，等待目录解锁/刷新...`, 'color:#FF9800');
                    } else {
                        console.log('%c课程目录尚未渲染完成，等待激活节点出现...', 'color:#FF9800');
                    }

                    if (Date.now() >= deadline) {
                        return {};
                    }
                    await this._sleep(this.configs.unlockWaitIntervalMs);
                }
            },

            async _clickAndVerify(target) {
                for (let attempt = 1; attempt <= this.configs.clickRetryTimes; attempt++) {
                    const node = this._getTargetNode(target);
                    if (!node) {
                        console.warn('%c目标节点从目录中消失，转入兜底流程', 'color:#FF9800');
                        return false;
                    }
                    if (attempt === 1) {
                        console.log(`%c目标小节: 第${target.cellIndex + 1}章 第${target.nodeIndex + 1}节`, 'color:#FF9800');
                    }
                    this._clickCatalogNode(node, attempt);
                    if (await this._waitActiveMoved(target)) {
                        return true;
                    }
                    console.warn(`%c第${attempt}次点击后未检测到页面跳转${attempt < this.configs.clickRetryTimes ? '，稍后重试' : ''}`, 'color:#FF9800');
                    if (attempt < this.configs.clickRetryTimes) {
                        await this._sleep(this.configs.clickRetryGapMs);
                    }
                }
                return false;
            },

            async _waitActiveMoved(target) {
                const deadline = Date.now() + this.configs.verifyMaxMs;
                while (true) {
                    await this._sleep(this.configs.verifyIntervalMs);
                    if (this._isTargetActive(target)) {
                        return true;
                    }
                    if (Date.now() >= deadline) {
                        return this._isTargetActive(target);
                    }
                }
            },

            _isTargetActive(target) {
                try {
                    const cells = this._getTreeContainer().children('ul').children('li');
                    const nCells = $(cells.get(target.cellIndex)).find('.posCatalog_select:not(.firstLayer)');
                    return nCells.eq(target.nodeIndex).hasClass('posCatalog_active');
                } catch (e) {
                    return false;
                }
            },

            _getActivePos() {
                try {
                    const cells = this._getTreeContainer().children('ul').children('li');
                    let pos = null;
                    cells.each((i, v) => {
                        const nCells = $(v).find('.posCatalog_select:not(.firstLayer)');
                        nCells.each((j, e) => {
                            if (pos === null && $(e).hasClass('posCatalog_active')) {
                                pos = { cellIndex: i, nodeIndex: j };
                            }
                        });
                    });
                    return pos;
                } catch (e) {
                    return null;
                }
            },

            // 点击目录节点：优先 .posCatalog_name，退化到节点本体；派发原生 mousedown/mouseup/click 序列
            _clickCatalogNode(nCell, attempt) {
                const $nCell = $(nCell);
                const nameSpan = $nCell.find('.posCatalog_name')[0];
                const el = nameSpan || nCell;
                const title = (nameSpan && $(nameSpan).attr('title')) || '未知标题';
                console.log(`%c[第${attempt}次]点击切换到: ${title}`, 'color:#2196F3');

                const rect = el.getBoundingClientRect();
                const opts = {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    clientX: Math.round(rect.left + Math.max(rect.width / 2, 1)),
                    clientY: Math.round(rect.top + Math.max(rect.height / 2, 1)),
                };
                try {
                    el.dispatchEvent(new MouseEvent('mousedown', opts));
                    el.dispatchEvent(new MouseEvent('mouseup', opts));
                } catch (e) {}
                el.click();
            },

            // 兜底：点击网站自带的“下一节”按钮，以“内容身份变化”验证结果
            // V3.3.2：弃用“旧视频脱离文档”判据——iframe 重载但内容不变时会造成假阳性
            async _fallbackNextButton() {
                const btn = $('#prevNextFocusNext');
                if (btn.length === 0) {
                    console.warn('%c未找到网站“下一节”按钮（#prevNextFocusNext），兜底失败', 'color:#FF9800');
                    return false;
                }
                console.log('%c尝试点击网站“下一节”按钮兜底...', 'color:#FF9800');
                btn[0].click();

                const base = this._navBaseline;
                if (!base) {
                    return true;
                }
                const deadline = Date.now() + this.configs.verifyMaxMs;
                while (true) {
                    await this._sleep(this.configs.verifyIntervalMs);
                    if (this._contentIdentityChanged(base)) {
                        return true;
                    }
                    if (Date.now() >= deadline) {
                        return false;
                    }
                }
            },

            // V3.3.2：记录跳转前的内容身份。knowledgeid 标识知识点，
            // iframe 重载/缓存戳/页签变化都不会改变它，是可靠的“内容变了”信号
            _captureContentIdentity() {
                let url = '';
                try {
                    const iframe = $('iframe').eq(0)[0];
                    if (iframe) {
                        // 优先读实时 URL（同源可读）；src 属性可能滞后且可能带时间戳/缓存参数
                        url = String((iframe.contentWindow && iframe.contentWindow.location.href) || iframe.getAttribute('src') || '');
                    }
                } catch (e) {
                    url = '';
                }
                const m = url.match(/knowledgeid=(\d+)/i);
                const pos = this._getActivePos();
                return {
                    knowledgeId: m ? m[1] : '',
                    pos: pos ? `${pos.cellIndex}:${pos.nodeIndex}` : '',
                };
            },

            _contentIdentityChanged(base) {
                if (!base) return true;
                // 基线为空时无法判定，放行（避免误杀正常跳转）
                if (!base.knowledgeId && !base.pos) return true;
                const now = this._captureContentIdentity();
                if (base.knowledgeId && now.knowledgeId) {
                    return now.knowledgeId !== base.knowledgeId;
                }
                if (base.pos && now.pos) {
                    return now.pos !== base.pos;
                }
                return true;
            },

            async _waitContentChanged(base) {
                const deadline = Date.now() + 5000;
                while (true) {
                    if (this._contentIdentityChanged(base)) {
                        console.log('%c内容验证: 轮询后检测到内容已切换', 'color:#607D8B');
                        return true;
                    }
                    if (Date.now() >= deadline) return false;
                    await this._sleep(this.configs.verifyIntervalMs);
                }
            },

            async _onNavigateSuccess() {
                // V3.3.2 内容变化闸：所有“误判成功”（兜底假阳性、索引漂移等）都汇聚到
                // 这里。内容未变化绝不播放当前视频，转为失败走重试流程
                const base = this._navBaseline;
                if (base) {
                    const now = this._captureContentIdentity();
                    const changed = this._contentIdentityChanged(base);
                    console.log(`%c内容验证: knowledgeId=${base.knowledgeId || '无'}→${now.knowledgeId || '无'}, pos=${base.pos || '无'}→${now.pos || '无'}, 判定=${changed ? '已切换' : '未切换'}`, 'color:#607D8B');
                    if (!changed && !(await this._waitContentChanged(base))) {
                        console.error('%c页面内容未发生变化，判定跳转失败（防止重播当前视频）', 'color:#F44336;font-weight:bold');
                        this._onNavigateFailure('页面内容未发生变化');
                        return;
                    }
                }
                console.log('%c===========小节跳转成功，准备接管新内容===========', 'color:#4CAF50;font-weight:bold');
                this._navFailCount = 0;
                this._loadGraceUntil = Date.now() + this.configs.loadGraceMs;
                this._videoEl = null;
                this._isPlaying = false;
                this._switching = false;
                try {
                    this._initCellData();
                } catch (e) {}
                if (this.configs.autoplay) {
                    this.play();
                }
            },

            _onNavigateFailure(reason) {
                console.error(`%c===========小节跳转失败：${reason}===========`, 'color:#F44336;font-weight:bold');
                this._switching = false;
                this._navFailCount++;
                if (this._navFailCount <= this.configs.navFailRetryTimes) {
                    console.log(`%c${this.configs.navFailRetryGapMs / 1000}秒后重试整个跳转流程（第${this._navFailCount}/${this.configs.navFailRetryTimes}次）`, 'color:#FF9800');
                    setTimeout(() => this.nextUnit(), this.configs.navFailRetryGapMs);
                } else {
                    console.error('%c连续跳转失败次数已达上限，已停止自动跳转。请手动点击下一小节后执行 app.run() 重新接管', 'color:#F44336;font-weight:bold');
                    this._clearCheckInterval();
                }
            },

            _sleep(ms) {
                return new Promise((resolve) => setTimeout(resolve, ms));
            },

            _clearCheckInterval() {
                if (this._checkInterval) {
                    clearInterval(this._checkInterval);
                    this._checkInterval = null;
                }
            },
            _startVideoMonitoring() {
                this._clearCheckInterval();
                this._guardLastTime = 0;
                this._guardLastWallTs = 0;
                this._guardLastResumeTs = 0;
                this._checkInterval = setInterval(() => {
                    this._checkVideoStatus();
                }, this.configs.videoCheckInterval);
            },
            _tryResumePlayback(reason) {
                // 跳转流程进行中不允许恢复播放（防止切页等事件重启已结束的旧视频）
                if (this._switching) return;

                const now = Date.now();
                if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) {
                    return;
                }
                this._guardLastResumeTs = now;

                const video = this._getVideoEl();
                if (!video || !this._isPlaying) return;

                console.log(`%c触发视频保活恢复(${reason})`, 'color:#607D8B');
                video.play().catch((e) => {
                    console.warn('直接恢复播放失败，尝试静音恢复:', e);
                    video.muted = true;
                    video.play().catch((err) => {
                        console.error('静音恢复播放失败:', err);
                    });
                });
            },
            _checkVideoStatus() {
                // 跳转流程进行中暂停状态检查
                if (this._switching) return;
                try {
                    const video = this._getVideoEl();
                    if (!video) return;

                    // ended 的视频属于“播放结束”，交给 ended 分支处理，绝不“恢复播放”（否则会从头重播）
                    if (video.paused && !video.ended && this._isPlaying) {
                        console.log('%c检测到视频暂停，尝试恢复播放...', 'color:#FF5722');
                        this._tryResumePlayback('paused');
                    } else if (this._isPlaying && !video.ended) {
                        const now = Date.now();
                        const current = Number(video.currentTime || 0);
                        if (this._guardLastWallTs === 0) {
                            this._guardLastWallTs = now;
                            this._guardLastTime = current;
                        } else {
                            const stalled = Math.abs(current - this._guardLastTime) < 0.01;
                            const stalledMs = now - this._guardLastWallTs;
                            if (stalled && stalledMs >= this.configs.guardNoProgressMs) {
                                this._tryResumePlayback('no-progress');
                                this._guardLastWallTs = now;
                                this._guardLastTime = Number(video.currentTime || 0);
                            } else if (!stalled) {
                                this._guardLastWallTs = now;
                                this._guardLastTime = current;
                            }
                        }
                    }

                    if (video.ended && this._isPlaying) {
                        console.log('%c检测到视频结束，准备切换下一个...', 'color:#9C27B0');
                        this._isPlaying = false;
                        setTimeout(() => this.nextUnit(), 1000);
                    }
                } catch (e) {
                    console.error('视频状态检查失败:', e);
                }
            },
            _tryTimes: 0,
            _stepSwitchAt: 0,
            _stepSwitchPending: false,
            _delayedNextUnitTimer: null,
            _guardLastTime: 0,
            _guardLastWallTs: 0,
            _guardLastResumeTs: 0,
            async play() {
                // 总闸：跳转流程（等待解锁/点击/验证）进行中，任何播放请求一律拒绝，
                // 防止残留定时器、loadedmetadata 回调等重启已结束的旧视频
                if (this._switching) {
                    console.log('%c[play] 跳转流程进行中，忽略播放请求（防止重启旧视频）', 'color:#607D8B');
                    return;
                }
                try {
                    const el = this._getVideoEl();
                    if (el == null) {
                        // 刚完成跳转、新内容还在加载：只等待，不点页签/下一节，防止误触发跳过
                        if (Date.now() < this._loadGraceUntil) {
                            console.log('%c新小节内容加载中，等待视频出现...', 'color:#607D8B');
                            setTimeout(() => {
                                this.play();
                            }, 2000);
                            return;
                        }
                        if (this._advanceLearningStep()) {
                            console.log('%c当前不在视频页，已尝试切到下一学习步骤，2秒后重试', 'color:#607D8B');
                            setTimeout(() => {
                                this.play();
                            }, 2000);
                            return;
                        }
                        console.log('%c===========跳过章节测验，2秒后继续播放==============', 'color:#607D8B');
                        $('#prevNextFocusNext').click();
                        setTimeout(() => {
                            this.play();
                        }, 2000);
                        return;
                    }

                    this._tryTimes = 0;
                    this._isPlaying = true;
                    this._videoEventHandle();
                    el.playbackRate = this.configs.playbackRate;

                    try {
                        await el.play();
                        console.log(`%c视频开始播放，倍速: ${el.playbackRate}x`, 'color:#4CAF50');
                        this._startVideoMonitoring();
                    } catch (playError) {
                        console.error('视频播放失败:', playError);
                        this._handlePlayError(playError);
                    }
                } catch (e) {
                    if (this._tryTimes > this.configs.maxRetries) {
                        console.error('%c视频播放失败，已达到最大重试次数', 'color:#F44336;font-weight:bold', e);
                        this._clearCheckInterval();
                        return;
                    }
                    this._tryTimes++;
                    console.log(`%c播放失败，${this.configs.retryInterval / 1000}秒后重试 (${this._tryTimes}/${this.configs.maxRetries})`, 'color:#FF9800');
                    setTimeout(() => {
                        this.play();
                    }, this.configs.retryInterval);
                }
            },
            _advanceLearningStep() {
                if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < 4000) {
                    return true;
                }

                const prevTitle = document.getElementsByClassName('prev_title')[0];
                const currentStepTitle = prevTitle ? (prevTitle.title || prevTitle.textContent || '').trim() : '';

                if (currentStepTitle === '章节测验' || currentStepTitle === '视频') {
                    return false;
                }

                const clickElement = (el, label) => {
                    if (!el) return false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    console.log(`%c尝试点击${label}`, 'color:#2196F3');
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    return true;
                };

                const videoTab = $('.prev_white:visible').filter((_, el) => {
                    const text = ($(el).text() || '').replace(/\s+/g, '');
                    return text === '2视频' || text === '视频';
                }).get(0);
                if (clickElement(videoTab, '“视频”页签')) {
                    return true;
                }

                return false;
            },
            _bindStepNavigation() {
                if (this._stepNavigationBound) {
                    return;
                }
                this._stepNavigationBound = true;

                const reenterVideoMode = () => {
                    this._videoEl = null;
                    this._isPlaying = false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    setTimeout(() => {
                        try {
                            this._initCellData();
                        } catch (e) {}
                        this.play();
                    }, 1800);
                };

                $(document).on('click', '.prev_white', (e) => {
                    const text = ($(e.currentTarget).text() || '').replace(/\s+/g, '');
                    if (text.includes('视频')) {
                        console.log(`%c检测到步骤切换点击：${text}，准备重新接管视频页`, 'color:#607D8B');
                        reenterVideoMode();
                    }
                });
            },
            _handlePlayError(error) {
                console.error('播放错误详情:', error);
                const video = this._getVideoEl();
                if (video) {
                    video.muted = true;
                    video.play().then(() => {
                        console.log('%c静音播放成功', 'color:#4CAF50');
                        if (this._delayedNextUnitTimer) {
                            clearTimeout(this._delayedNextUnitTimer);
                            this._delayedNextUnitTimer = null;
                        }
                    }).catch((e) => {
                        console.error('静音播放也失败:', e);
                        if (this._delayedNextUnitTimer) {
                            clearTimeout(this._delayedNextUnitTimer);
                        }
                        this._delayedNextUnitTimer = setTimeout(() => {
                            this._delayedNextUnitTimer = null;
                            this.nextUnit();
                        }, 3000);
                    });
                }
            },
            _initCellData() {
                const el = this._getTreeContainer();
                const cells = el.children('ul').children('li');
                this._cellData.cells = cells.length;
                let nCellCounts = 0;
                let foundCurrent = false;

                cells.each((i, v) => {
                    const nCells = $(v).find('.posCatalog_select:not(.firstLayer)');
                    nCellCounts += nCells.length;
                    nCells.each((j, e) => {
                        const _el = $(e);
                        if (_el.hasClass('posCatalog_active')) {
                            this._cellData.currentCellIndex = i;
                            this._cellData.currentNCellIndex = j;
                            foundCurrent = true;
                            const titleSpan = _el.find('.posCatalog_name')[0];
                            if (titleSpan) {
                                this._cellData.currentVideoTitle = $(titleSpan).attr('title');
                            }
                        }
                    });
                });

                this._cellData.nCells = nCellCounts;

                if (!foundCurrent && nCellCounts > 0) {
                    console.warn('%c未找到当前激活的视频节点，可能需要手动选择', 'color:#FF9800');
                }

                // 轮询等待期间会被频繁调用，只在统计结果变化时打印，避免刷屏
                const summary = `${this._cellData.cells}章, ${this._cellData.nCells}节, 当前: 第${this._cellData.currentCellIndex + 1}章第${this._cellData.currentNCellIndex + 1}节`;
                if (summary !== this._lastCellSummary) {
                    this._lastCellSummary = summary;
                    console.log(`%c课程信息: ${summary}`, 'color:#607D8B');
                }

                return foundCurrent;
            },
            _getTreeContainer() {
                // V3.3：每次都重新查询。网站刷新侧边栏可能整体替换 #coursetree，
                // 永久缓存会让引用脱钩成“僵尸DOM”——统计照旧但点击永远无效
                const el = $('#coursetree');
                if (el.length <= 0) {
                    throw new Error('找不到视频列表');
                }
                this._treeContainerEl = el;
                return el;
            },
            _getVideoEl() {
                if (!this._videoEl) {
                    try {
                        const frameObj = $('iframe').eq(0).contents().find('iframe.ans-insertvideo-online');
                        if (frameObj.length === 0) {
                            return null;
                        }
                        this._videoEl = frameObj.eq(0).contents().find('video#video_html5_api').get(0);
                    } catch (e) {
                        console.error('获取视频元素失败:', e);
                        return null;
                    }
                }
                if (!this._videoEl) {
                    throw new Error('视频组件Video未加载完成');
                }
                return this._videoEl;
            },
            _videoEventHandle() {
                const el = this._videoEl;
                if (!el) {
                    console.log('videoEl未加载');
                    return;
                }

                // V3.3：绑定固定的引用。原写法每次 play() 都 bind 新函数，
                // removeEventListener 移除不了旧绑定，导致 ended 等事件被重复注册
                if (!this._boundVideoHandlers) {
                    this._boundVideoHandlers = {
                        ended: this._handleVideoEnded.bind(this),
                        loadedmetadata: this._handleVideoLoaded.bind(this),
                        play: this._handleVideoPlay.bind(this),
                        pause: this._handleVideoPause.bind(this),
                    };
                }
                const h = this._boundVideoHandlers;

                el.removeEventListener('ended', h.ended);
                el.removeEventListener('loadedmetadata', h.loadedmetadata);
                el.removeEventListener('play', h.play);
                el.removeEventListener('pause', h.pause);

                el.addEventListener('ended', h.ended);
                el.addEventListener('loadedmetadata', h.loadedmetadata);
                el.addEventListener('play', h.play);
                el.addEventListener('pause', h.pause);
            },
            _handleVideoEnded(e) {
                const title = this._cellData.currentVideoTitle;
                console.warn(`%c============'${title}' 播放完成=============`, 'color:#4CAF50;font-weight:bold');
                this._isPlaying = false;
                this._clearCheckInterval();
                setTimeout(() => this.nextUnit(), 1000);
            },
            _handleVideoLoaded(e) {
                console.log('%c============视频加载完成=============', 'color:#2196F3');
                if (this.configs.autoplay && !this._isPlaying) {
                    this.play();
                }
            },
            _handleVideoPlay(e) {
                const title = this._cellData.currentVideoTitle;
                console.info(`%c============'${title}' 开始播放=============`, 'color:#4CAF50');
                this._isPlaying = true;
                this._stepSwitchPending = false;
                const video = this._getVideoEl();
                this._guardLastTime = Number(video?.currentTime || 0);
                this._guardLastWallTs = Date.now();
                if (this._delayedNextUnitTimer) {
                    clearTimeout(this._delayedNextUnitTimer);
                    this._delayedNextUnitTimer = null;
                }
            },
            _handleVideoPause(e) {
                console.log('%c============视频暂停=============', 'color:#FF9800');
            },
        };

        try {
            window.app.run();

            const preventPause = (e) => {
                e.stopPropagation();
                e.preventDefault();
            };

            const resumePlaybackNow = () => {
                if (window.app && typeof window.app._tryResumePlayback === 'function') {
                    window.app._tryResumePlayback('page-event');
                }
            };

            document.addEventListener('mouseleave', preventPause);
            window.addEventListener('mouseleave', preventPause);
            document.addEventListener('mouseout', preventPause);
            window.addEventListener('mouseout', preventPause);

            window.addEventListener('blur', () => {
                console.log('%c页面失去焦点，保持播放状态', 'color:#607D8B');
                resumePlaybackNow();
            });

            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    console.log('%c页面切到后台，尝试保持播放状态', 'color:#607D8B');
                }
                resumePlaybackNow();
            });
        } catch (error) {
            console.error('%c脚本运行失败: ', 'color:#F44336;font-weight:bold', error.message);
            console.log('请检查是否在正确的课程播放页面，或者页面结构是否再次发生改变。');
        }
    }
})();
