(function() {
	BOOMR = BOOMR || {};

	BOOMR.plugins = BOOMR.plugins || {};

	if (BOOMR.plugins.Continuity) {
		return;
	}

	//
	// Constants
	//

	/**
	 * Timeline collection interval
	 */
	var COLLECTION_INTERVAL = 100;

	/**
	 * Number of "idle" intervals (100ms) before Time to Interactive is called.
	 *
	 * 5 * 100 = 500ms of no long tasks > 50ms and FPS >= 20
	 */
	var TIME_TO_INTERACTIVE_IDLE_INTERVALS = 5;

	/**
	 * For Time to Interactive, minimum FPS.
	 *
	 * ~20 FPS or max ~50ms blocked
	 */
	var TIME_TO_INTERACTIVE_MIN_FPS = 20;

	/**
	 * For Time to Interactive, minimum FPS per COLLECTION_INTERVAL.
	 */
	var TIME_TO_INTERACTIVE_MIN_FPS_PER_INTERVAL =
		TIME_TO_INTERACTIVE_MIN_FPS / (1000 / COLLECTION_INTERVAL);

	// Performance object
	var p = BOOMR.getPerformance();

	// Metrics that will be exported
	var externalMetrics = {};

	/**
	 * Keeps track of counts of events that happen over time (in
	 * COLLECTION_INTERVAL intervals).
	 *
	 * Also handles calculating TimeToInteractive (TTI).
	 *
	 * @class Timeline
	 */
	var Timeline = function(startTime) {
		//
		// Local Members
		//

		// TODO Max seconds recording (60?)
		// TODO eventlog, not just counts (mouse, scroll, keyboard, etc)

		// timeline data
		var data = {};

		// time-to-interactive timestamp
		var tti = 0;

		// visually ready timestamp
		var visuallyReady = 0;

		// check for pre-Boomerang FPS log
		if (BOOMR.fpsLog && BOOMR.fpsLog.length && p && p.timing) {
			// start at the first frame instead of now
			startTime = BOOMR.fpsLog[0] + p.timing.navigationStart;

			// FrameRateMonitor will remove fpsLog
		}

		//
		// Functions
		//
		/**
		 * Registers a monitor
		 *
		 * @param {string} type Type
		 */
		function register(type) {
			if (!data[type]) {
				data[type] = [];
			}
		}

		/**
		 * Gets the current time bucket
		 *
		 * @returns {number} Current time bucket
		 */
		function getTime() {
			return Math.floor((BOOMR.now() - startTime) / COLLECTION_INTERVAL);
		}

		/**
		 * Sets data for the specified type.
		 *
		 * The type should be registered first via {@link register}.
		 *
		 * @param {string} type Type
		 * @param {number} [value] Value
		 * @param {number} [time] Time
		 */
		function set(type, value, time) {
			if (typeof time === "undefined") {
				time = getTime();
			}

			if (!data[type]) {
				return;
			}

			data[type][time] = value;
		}

		/**
		 * Increments data for the specified type
		 *
		 * The type should be registered first via {@link register}.
		 *
		 * @param {string} type Type
		 * @param {number} [value] Value
		 * @param {number} [time] Time
		 */
		function increment(type, value, time) {
			if (typeof time === "undefined") {
				time = getTime();
			}

			if (typeof value === "undefined") {
				value = 1;
			}

			if (!data[type]) {
				return;
			}

			if (!data[type][time]) {
				data[type][time] = 0;
			}

			data[type][time] += value;
		}

		/**
		 * Gets stats for a type since the specified start time.
		 *
		 * @param {string} type Type
		 * @param {number} since Start time
		 *
		 * @returns {object} Stats for the type
		 */
		function getStats(type, since) {
			var count = 0,
			    total = 0,
			    min = Infinity,
			    val,
			    sinceBucket = Math.floor((since - startTime) / COLLECTION_INTERVAL);

			if (!data[type]) {
				return 0;
			}

			for (var bucket in data[type]) {
				bucket = parseInt(bucket, 10);

				if (data[type].hasOwnProperty(bucket)) {
					if (bucket >= sinceBucket) {
						// calculate count, total and minimum
						count++;
						total += data[type][bucket];

						min = Math.min(min, data[type][bucket]);
					}
				}
			}

			// return the stats
			return {
				total: total,
				count: count,
				min: min
			};
		}

		/**
		 * Given a CSS selector, determine the load time of any IMGs matching
		 * that selector and/or IMGs underneath it.
		 *
		 * @param {string} selector CSS selector
		 *
		 * @returns {number} Last image load time
		 */
		function determineImageLoadTime(selector) {
			var combinedSelector, elements, latestTs = 0, i, j, src, entries;

			// check to see if we have querySelectorAll available
			if (!BOOMR.window ||
			    !BOOMR.window.document ||
			    typeof BOOMR.window.document.querySelectorAll !== "function") {
				// can't use querySelectorAll
				return 0;
			}

			// check to see if we have ResourceTiming available
			if (!p ||
			    typeof p.getEntriesByType !== "function") {
				// can't use ResourceTiming
				return 0;
			}

			combinedSelector = selector + ", " + selector + " * img";
			elements = BOOMR.window.document.querySelectorAll(combinedSelector);
			if (elements && elements.length) {
				for (i = 0; i < elements.length; i++) {
					src = elements[i].src;
					if (src) {
						entries = p.getEntriesByName(src);
						if (entries && entries.length) {
							for (j = 0; j < entries.length; j++) {
								latestTs = Math.max(latestTs, entries[j].responseEnd);
							}
						}
					}
				}
			}

			return latestTs ? Math.floor(latestTs + p.timing.navigationStart) : 0;
		}

		/**
		 * Determine Visually Ready time.  This is the last of:
		 * 1. First Paint (if available)
		 * 2. domContentLoadedEventEnd
		 * 3. Hero Images are loaded (if configured)
		 * 4. Framework Ready (if configured)
		 *
		 * @returns {number|undefined} Timestamp, if everything is ready, or
		 *    `undefined` if not
		 */
		function determineVisuallyReady() {
			var latestTs = 0;

			// start with Framework Ready (if configured)
			if (impl.ttiWaitForFrameworkReady) {
				if (!impl.frameworkReady) {
					return;
				}

				latestTs = impl.frameworkReady;
			}

			// use IE's First Paint (if available) or
			// use Chrome's firstPaintTime (if available)
			if (p && p.timing && p.timing.msFirstPaint) {
				latestTs = Math.max(latestTs, p.timing.msFirstPaint);
			}
			else if (BOOMR.window &&
			    BOOMR.window.chrome &&
			    typeof BOOMR.window.chrome.loadTimes === "function") {
				var loadTimes = BOOMR.window.chrome.loadTimes();
				if (loadTimes && loadTimes.firstPaintTime) {
					latestTs = Math.max(latestTs, loadTimes.firstPaintTime * 1000);
				}
			}

			// Use domContentLoadedEventEnd (if available)
			if (p && p.timing && p.timing.domContentLoadedEventEnd) {
				latestTs = Math.max(latestTs, p.timing.domContentLoadedEventEnd);
			}

			// look up any Hero Images (if configured)
			if (impl.ttiWaitForHeroImages) {
				var heroLoadTime = determineImageLoadTime(impl.ttiWaitForHeroImages);

				if (heroLoadTime) {
					latestTs = Math.max(latestTs, heroLoadTime);
				}
			}

			return latestTs;
		}

		/**
		 * Analyzes metrics such as Time To Interactive
		 */
		function analyze() {
			var endBucket = getTime(),
			    j = 0,
			    idleIntervals = 0;

			if (tti) {
				return;
			}

			// need to get Visually Ready first
			visuallyReady = determineVisuallyReady();
			if (!visuallyReady) {
				return;
			}

			// add Visually Ready to the beacon
			impl.addToBeacon("c.tti.vr", externalMetrics.timeToVisuallyReady());

			// Calculate TTI
			if (!data.longtask || !data.fps) {
				// can't calculate TTI
				return;
			}

			// determine the first bucket we'd use
			var startBucket = Math.floor((visuallyReady - startTime) / COLLECTION_INTERVAL);

			for (j = startBucket; j <= endBucket; j++) {
				if (data.longtask[j]) {
					// had a long task during this interval
					idleIntervals = 0;
					continue;
				}

				if (!data.fps[j] || data.fps[j] < TIME_TO_INTERACTIVE_MIN_FPS_PER_INTERVAL) {
					// No FPS or less than 20 FPS during this interval
					idleIntervals = 0;
					continue;
				}

				// this was an idle interval
				idleIntervals++;

				// if we've found enough idle intervals, mark TTI as the beginning
				// of this idle period
				if (idleIntervals >= TIME_TO_INTERACTIVE_IDLE_INTERVALS) {
					tti = startTime + ((j - TIME_TO_INTERACTIVE_IDLE_INTERVALS) * COLLECTION_INTERVAL);
					break;
				}
			}

			if (tti > 0) {
				impl.addToBeacon("c.tti", externalMetrics.timeToInteractive());
			}
		}

		//
		// External metrics
		//

		/**
		 * Time to Interactive
		 */
		externalMetrics.timeToInteractive = function() {
			if (tti && p && p.timing && p.timing.navigationStart) {
				// milliseconds since nav start
				return tti - p.timing.navigationStart;
			}

			// no data
			return;
		};

		/**
		 * Time to Visually Ready
		 */
		externalMetrics.timeToVisuallyReady = function() {
			if (visuallyReady && p && p.timing && p.timing.navigationStart) {
				// milliseconds since nav start
				return visuallyReady - p.timing.navigationStart;
			}

			// no data
			return;
		};

		/**
		 * Disables the monitor
		 */
		function stop() {
			data = {};
		}

		/**
		 * Resets on beacon
		 */
		function onBeacon() {
			for (var type in data) {
				if (data.hasOwnProperty(type)) {
					data[type] = [];
				}
			}
		}

		return {
			register: register,
			set: set,
			increment: increment,
			getTime: getTime,
			getStats: getStats,
			analyze: analyze,
			stop: stop,
			onBeacon: onBeacon
		};
	};

	/**
	 * @class LongTaskMonitor
	 */
	var LongTaskMonitor = function(w, t) {
		if (!w.PerformanceObserver) {
			return;
		}

		//
		// Constants
		//
		/**
		 * LongTask attribution types
		 */
		var ATTRIBUTION_TYPES = {
			"unknown": 0,
			"self": 1,
			"same-origin-ancestor": 2,
			"same-origin-descendant": 3,
			"same-origin": 4,
			"cross-origin-ancestor": 5,
			"cross-origin-descendant": 6,
			"cross-origin-unreachable": 7,
			"multiple-contexts": 8
		};

		/**
		 * LongTask culprit attribution names
		 */
		var CULPRIT_ATTRIBUTION_NAMES = {
			"unknown": 0,
			"script": 1,
			"layout": 2
		};

		/**
		 * LongTask culprit types
		 */
		var CULPRIT_TYPES = {
			"unknown": 0,
			"iframe": 1,
			"embed": 2,
			"object": 2
		};

		//
		// Local Members
		//

		// PerformanceObserver
		var perfObserver = new w.PerformanceObserver(onPerformanceObserver);

		try {
			perfObserver.observe({ entryTypes: ["longtask"] });
		}
		catch (e) {
			// longtask not supported
			return;
		}

		// register this type
		t.register("longtask");

		// Long Tasks array
		var longTasks = [];

		// whether or not we're enabled
		var enabled = true;

		// total time of long tasks
		var longTasksTime = 0;

		// long tasks count
		var longTasksCount = 0;

		// long tasks supported
		var longTasksSupported = false;

		/**
		 * Callback for the PerformanceObserver
		 */
		function onPerformanceObserver(list) {
			var entries, i;

			longTasksSupported = true;

			if (!enabled) {
				return;
			}

			// just capture all of the data for now, we'll analyze at the beacon
			entries = list.getEntries();
			Array.prototype.push.apply(longTasks, entries);

			// add total time and count of long tasks
			for (i = 0; i < entries.length; i++) {
				longTasksTime += entries[i].duration;
				longTasksCount++;
			}

			// add to the timeline
			t.increment("longtask", entries.length);
		}

		/**
		 * Gets the current list of tasks
		 *
		 * @returns {PerformanceEntry[]} Tasks
		 */
		function getTasks() {
			return longTasks;
		}

		/**
		 * Clears the Long Tasks
		 */
		function clearTasks() {
			longTasks = [];

			longTasksTime = 0;
			longTasksCount = 0;
		}

		/**
		 * Analyzes LongTasks
		 */
		function analyze(startTime) {
			var totalTime = 0, i, j, task, obj, objs = [], attrs = [], attr;

			if (longTasks.length === 0) {
				return;
			}

			for (i = 0; i < longTasks.length; i++) {
				task = longTasks[i];

				totalTime += task.duration;

				// compress the object a bit
				obj = {
					s: Math.round(task.startTime).toString(36),
					d: Math.round(task.duration).toString(36),
					n: ATTRIBUTION_TYPES[task.name] ? ATTRIBUTION_TYPES[task.name] : 0
				};

				attrs = [];

				for (j = 0; j < task.attribution.length; j++) {
					attr = task.attribution[j];

					// skip script/iframe with no attribution
					if (attr.name === "script" &&
					    attr.containerType === "iframe" &&
					    !attr.containerName &&
						!attr.containerId && !attr.containerSrc) {
						continue;
					}

					// only use containerName if not the same as containerId
					var containerName = attr.containerName ? attr.containerName : undefined;
					var containerId = attr.containerId ? attr.containerId : undefined;
					if (containerName === containerId) {
						containerName = undefined;
					}

					// only use containerSrc if containerId is undefined
					var containerSrc = containerId === undefined ? attr.containerSrc : undefined;

					attrs.push({
						a: CULPRIT_ATTRIBUTION_NAMES[attr.name] ? CULPRIT_ATTRIBUTION_NAMES[attr.name] : 0,
						t: CULPRIT_TYPES[attr.containerType] ? CULPRIT_TYPES[attr.containerType] : 0,
						n: containerName,
						i: containerId,
						s: containerSrc
					});
				}

				if (attrs.length > 0) {
					obj.a = attrs;
				}

				objs.push(obj);
			}

			// add data to beacon
			impl.addToBeacon("c.lt.n", longTasks.length);
			impl.addToBeacon("c.lt.tt", totalTime);
			impl.addToBeacon("c.lt", JSON.stringify(objs));
		}

		/**
		 * Disables the monitor
		 */
		function stop() {
			enabled = false;

			perfObserver.disconnect();

			clearTasks();
		}

		/**
		 * Resets on beacon
		 */
		function onBeacon() {
			clearTasks();
		}

		//
		// External metrics
		//

		/**
		 * Total time of LongTasks (ms)
		 */
		externalMetrics.longTasksTime = function() {
			return longTasksTime;
		};

		/**
		 * Number of LongTasks
		 */
		externalMetrics.longTasksCount = function() {
			return longTasksCount;
		};

		/**
		 * Whether or not LongTasks is supported.
		 *
		 * We can only detect this if there was at least one LongTask
		 */
		externalMetrics.longTasksSupported = function() {
			return longTasksSupported;
		};

		return {
			getTasks: getTasks,
			clearTasks: clearTasks,
			analyze: analyze,
			stop: stop,
			onBeacon: onBeacon
		};
	};

	// TODO Page Busy if LongTask and FPS aren't supported
	// https://github.com/nicjansma/talks/blob/master/measuring-continuity/examples/cpu-page-busy.js

	/**
	 * @class FrameRateMonitor
	 */
	var FrameRateMonitor = function(w, t) {
		// register this type
		t.register("fps");

		//
		// Constants
		//

		// long frame maximum milliseconds (1000 / 60 = 16.6 + a little wiggle)
		var LONG_FRAME_MAX = 18;

		//
		// Local Members
		//

		// total frames seen
		var totalFrames = 0;

		// long frames
		var longFrames = 0;

		// time we started monitoring
		var frameStartTime;

		// last frame we saw
		var lastFrame;

		// whether or not we're enabled
		var enabled = true;

		// check for pre-Boomerang FPS log
		if (BOOMR.fpsLog && BOOMR.fpsLog.length && p && p.timing) {
			lastFrame = frameStartTime = BOOMR.fpsLog[0] + p.timing.navigationStart;

			// transition any FPS log events to our timeline
			for (var i = 0; i < BOOMR.fpsLog.length; i++) {
				var ts = p.timing.navigationStart + BOOMR.fpsLog[i];

				// update the frame count for this time interval
				t.increment("fps", 1, Math.floor((ts - frameStartTime) / COLLECTION_INTERVAL));

				// calculate how long this frame took
				if (ts - lastFrame >= LONG_FRAME_MAX) {
					longFrames++;
				}

				// last frame timestamp
				lastFrame = ts;
			}

			totalFrames = BOOMR.fpsLog.length;

			delete BOOMR.fpsLog;
		}
		else {
			frameStartTime = BOOMR.now();
		}

		/**
		 * requestAnimationFrame callback
		 */
		function frame() {
			var now;

			if (!enabled) {
				return;
			}

			now = BOOMR.now();

			// calculate how long this frame took
			if (now - lastFrame >= LONG_FRAME_MAX) {
				longFrames++;
			}

			// last frame timestamp
			lastFrame = now;

			// keep track of total frames we've seen
			totalFrames++;

			// increment the FPS
			t.increment("fps");

			// request the next frame
			w.requestAnimationFrame(frame);
		}

		/**
		 * Analyzes FPS
		 */
		function analyze(startTime) {
			impl.addToBeacon("c.f", externalMetrics.fps());
			impl.addToBeacon("c.f.d", externalMetrics.fpsDuration());
			impl.addToBeacon("c.f.m", externalMetrics.fpsMinimum());
			impl.addToBeacon("c.f.l", externalMetrics.fpsLongFrames());
			impl.addToBeacon("c.f.s", externalMetrics.fpsStart());
		}

		/**
		 * Disables the monitor
		 */
		function stop() {
			enabled = false;
			frameStartTime = 0;
		}

		/**
		 * Resets on beacon
		 */
		function onBeacon() {
			if (enabled) {
				// restart to now
				frameStartTime = BOOMR.now();
			}

			totalFrames = 0;
			longFrames = 0;
		}

		// start the first frame
		w.requestAnimationFrame(frame);

		//
		// External metrics
		//

		/**
		 * Framerate since fpsStart
		 */
		externalMetrics.fps = function() {
			var dur = externalMetrics.fpsDuration();
			if (dur) {
				return Math.floor(totalFrames / (dur / 1000));
			}
		};

		/**
		 * How long FPS was being tracked for
		 */
		externalMetrics.fpsDuration = function() {
			if (frameStartTime) {
				return BOOMR.now() - frameStartTime;
			}
		};

		/**
		 * Minimum FPS during the period
		 */
		externalMetrics.fpsMinimum = function() {
			var dur = externalMetrics.fpsDuration();
			if (dur) {
				var min = t.getStats("fps", frameStartTime).min;
				return min !== Infinity ? min : undefined;
			}
		};

		/**
		 * Number of long frames (over 18ms)
		 */
		externalMetrics.fpsLongFrames = function() {
			return longFrames;
		};

		/**
		 * When FPS tracking started (base 36)
		 */
		externalMetrics.fpsStart = function() {
			return frameStartTime ? frameStartTime.toString(36) : 0;
		};

		return {
			analyze: analyze,
			stop: stop,
			onBeacon: onBeacon
		};
	};

	// TODO video framerate
	// https://github.com/nicjansma/talks/blob/master/measuring-continuity/examples/fps-video.js

	/**
	 * @class ScrollMonitor
	 */
	var ScrollMonitor = function(w, t, i) {
		if (!w || !w.document || !w.document.body || !w.document.documentElement) {
			// something's wrong with the DOM, abort
			return;
		}

		//
		// Constants
		//

		// number of milliseconds between each distinct scroll
		var DISTINCT_SCROLL_SECONDS = 2000;

		//
		// Local Members
		//

		// last scroll Y
		var lastY = 0;

		// scroll % this period
		var intervalScrollPct = 0;

		// scroll % total
		var totalScrollPct = 0;

		// number of scroll events
		var scrollCount = 0;

		// total scroll pixels
		var scrollPixels = 0;

		// number of distinct scrolls (scroll which happened
		// over DISTINCT_SCROLL_SECONDS seconds apart)
		var distinctScrollCount = 0;

		// last time we scrolled
		var lastScroll = 0;

		// collection interval id
		var collectionInterval = false;

		// body and html element
		var body = w.document.body;
		var html = w.document.documentElement;

		// register this type
		t.register("scroll");
		t.register("scrollpct");

		function onScroll() {
			var now = BOOMR.now();

			scrollCount++;

			// see if this is a unique scroll
			if (now - lastScroll > DISTINCT_SCROLL_SECONDS) {
				distinctScrollCount++;
			}

			lastScroll = now;

			// height of the document
			// TODO: Calculate once?
			var height = Math.max(
				body.scrollHeight,
				body.offsetHeight,
				html.clientHeight,
				html.scrollHeight,
				html.offsetHeight) - w.innerHeight;

			// determine how many pixels were scrolled
			var curY = w.scrollY;
			var diffY = Math.abs(lastY - curY);

			scrollPixels += diffY;

			// update the timeline
			t.increment("scroll", diffY);

			// update the interaction monitor
			i.interact("scroll", now);

			// calculate percentage of document scrolled
			intervalScrollPct += Math.round(diffY / height * 100);
			totalScrollPct += Math.round(diffY / height * 100);

			lastY = curY;
		}

		/**
		 * Reports on the number of scrolls seen
		 */
		function reportScroll() {
			t.set("scrollpct", Math.min(intervalScrollPct, 100));

			// reset count
			intervalScrollPct = 0;
		}

		/**
		 * Analyzes Scrolling events
		 */
		function analyze(startTime) {
			impl.addToBeacon("c.s", externalMetrics.scrollCount());
			impl.addToBeacon("c.s.p", externalMetrics.scrollPct());
			impl.addToBeacon("c.s.y", externalMetrics.scrollPixels());
			impl.addToBeacon("c.s.d", externalMetrics.scrollDistinct());
		}

		/**
		 * Disables the monitor
		 */
		function stop() {
			if (collectionInterval) {
				clearInterval(collectionInterval);

				collectionInterval = false;
			}

			w.removeEventListener("scroll", onScroll);
		}

		/**
		 * Resets on beacon
		 */
		function onBeacon() {
			// TODO: Do we reset on beacon?
			totalScrollPct = 0;
			scrollCount = 0;
			scrollPixels = 0;
			distinctScrollCount = 0;
		}

		//
		// External metrics
		//

		/**
		 * Percentage of the screen that was scrolled.
		 *
		 * All the way to the bottom = 100%
		 */
		externalMetrics.scrollPct = function() {
			return totalScrollPct;
		};

		/**
		 * Number of scrolls
		 */
		externalMetrics.scrollCount = function() {
			return scrollCount;
		};

		/**
		 * Number of scrolls (more than two seconds apart)
		 */
		externalMetrics.scrollDistinct = function() {
			return distinctScrollCount;
		};

		/**
		 * Number of pixels scrolled
		 */
		externalMetrics.scrollPixels = function() {
			return scrollPixels;
		};

		// startup
		w.addEventListener("scroll", onScroll, false);

		collectionInterval = setInterval(reportScroll, COLLECTION_INTERVAL);

		return {
			analyze: analyze,
			stop: stop,
			onBeacon: onBeacon
		};
	};

	/**
	 * @class ClickMonitor
	 */
	var ClickMonitor = function(w, t, i) {
		// register this type
		t.register("click");

		//
		// Constants
		//

		// number of pixels area for Rage Clicks
		var PIXEL_AREA = 10;

		// number of clicks in the same area to trigger a Rage Click
		var RAGE_CLICK_THRESHOLD = 3;

		//
		// Local Members
		//

		// number of click events
		var clickCount = 0;

		// number of clicks in the same PIXEL_AREA area
		var sameClicks = 0;

		// number of Rage Clicks
		var rageClicks = 0;

		// last coordinates
		var x = 0;
		var y = 0;

		// last click target
		var lastTarget = null;

		// listen to click events
		function onClick(e) {
			var now = BOOMR.now();

			var newX = e.clientX;
			var newY = e.clientY;

			// track total number of clicks
			clickCount++;

			// calculate number of pixels moved
			var pixels = Math.round(
				Math.sqrt(Math.pow(y - newY, 2) +
				Math.pow(x - newX, 2)));

			// track Rage Clicks
			if (lastTarget === e.target || pixels <= PIXEL_AREA) {
				sameClicks++;

				if ((sameClicks + 1) >= RAGE_CLICK_THRESHOLD) {
					rageClicks++;
				}
			}
			else {
				sameClicks = 0;
			}

			// track last click coordinates and element
			x = newX;
			y = newY;
			lastTarget = e.target;

			// update the timeline
			t.increment("click");

			// update the interaction monitor
			i.interact("click", now);
		}

		/**
		 * Analyzes Click events
		 */
		function analyze(startTime) {
			impl.addToBeacon("c.c", externalMetrics.clicksCount());
			impl.addToBeacon("c.c.r", externalMetrics.clicksRage());
		}

		/**
		 * Disables the monitor
		 */
		function stop() {
			w.document.removeEventListener("click", onClick);
		}

		/**
		 * Resets on beacon
		 */
		function onBeacon() {
			// TODO: Do we reset on beacon?
			clickCount = 0;
			sameClicks = 0;
			rageClicks = 0;
		}

		//
		// External metrics
		//
		externalMetrics.clicksCount = function() {
			return clickCount;
		};

		externalMetrics.clicksRage = function() {
			return rageClicks;
		};

		// start
		w.document.addEventListener("click", onClick, false);

		return {
			analyze: analyze,
			stop: stop,
			onBeacon: onBeacon
		};
	};

	// TODO: Responsiveness after click
	// https://github.com/nicjansma/talks/blob/master/measuring-continuity/examples/responsiveness-after-click.js
	// TODO: Responsiveness after all other events?

	/**
	 * @class KeyMonitor
	 */
	var KeyMonitor = function(w, t, i) {
		// register this type
		t.register("key");

		//
		// Local members
		//

		// key presses
		var keyCount = 0;

		// esc key presses
		var escKeyCount = 0;

		function onKeyDown(e) {
			var now = BOOMR.now();

			keyCount++;

			if (e.keyCode === 27) {
				escKeyCount++;
			}

			// update the timeline
			t.increment("key");

			// update the interaction monitor
			i.interact("key", now);
		}

		/**
		 * Analyzes Key events
		 */
		function analyze(startTime) {
			impl.addToBeacon("c.k", externalMetrics.keyCount());
			impl.addToBeacon("c.k.e", externalMetrics.keyEscapes());
		}

		/**
		 * Disables the monitor
		 */
		function stop() {
			w.document.removeEventListener("keydown", onKeyDown);
		}

		/**
		 * Resets on beacon
		 */
		function onBeacon() {
			// TODO: Do we reset on beacon?
			keyCount = 0;
			escKeyCount = 0;
		}

		//
		// External metrics
		//
		externalMetrics.keyCount = function() {
			return keyCount;
		};

		externalMetrics.keyEscapes = function() {
			return escKeyCount;
		};

		// start
		w.document.addEventListener("keydown", onKeyDown, false);

		return {
			analyze: analyze,
			stop: stop,
			onBeacon: onBeacon
		};
	};

	/**
	 * @class MouseMonitor
	 */
	var MouseMonitor = function(w, t, i) {
		// register the mouse movements and overall percentage moved
		t.register("mouse");
		t.register("mousepct");

		//
		// Local members
		//

		// last movement coordinates
		var lastX = 0;
		var lastY = 0;

		// mouse move screen percent this interval
		var mousePct = 0;

		// total mouse move percent
		var totalMousePct = 0;

		// collection interval id
		var collectionInterval = false;

		// screen pixel count
		var screenPixels = Math.round(Math.sqrt(
			Math.pow(w.innerHeight, 2) +
			Math.pow(w.innerWidth, 2)));

		function onMouseMove(e) {
			var now = BOOMR.now();

			var newX = e.clientX;
			var newY = e.clientY;

			// calculate number of pixels moved
			var pixels = Math.round(Math.sqrt(Math.pow(lastY - newY, 2) +
									Math.pow(lastX - newX, 2)));

			// calculate percentage of screen moved (upper-left to lower-right = 100%)
			var newPct = Math.round(pixels / screenPixels * 100);
			mousePct += newPct;
			totalMousePct += newPct;

			lastX = newX;
			lastY = newY;

			// update the interaction monitor
			i.interact("mouse", now);

			t.increment("mouse", pixels);
		}

		/**
		 * Reports on the number of mouse events
		 */
		function reportMousePct() {
			t.set("mousepct", Math.min(mousePct, 100));

			// reset count
			mousePct = 0;
		}

		/**
		 * Analyzes Mouse events
		 */
		function analyze(startTime) {
			impl.addToBeacon("c.m.p", externalMetrics.mousePct());
		}

		/**
		 * Disables the monitor
		 */
		function stop() {
			if (collectionInterval) {
				clearInterval(collectionInterval);

				collectionInterval = false;
			}

			w.document.removeEventListener("mousemove", onMouseMove);
		}

		/**
		 * Resets on beacon
		 */
		function onBeacon() {
			// TODO: Do we reset on beacon?
			totalMousePct = 0;
		}

		//
		// External metrics
		//
		externalMetrics.mousePct = function() {
			return totalMousePct;
		};

		collectionInterval = setInterval(reportMousePct, COLLECTION_INTERVAL);

		// start
		w.document.addEventListener("mousemove", onMouseMove, false);

		return {
			analyze: analyze,
			stop: stop,
			onBeacon: onBeacon
		};
	};

	/**
	 * @class InteractionMonitor
	 */
	var InteractionMonitor = function(w, t) {
		// register this type
		t.register("interaction");

		//
		// Local Members
		//

		// Time of first interaction
		var timeToFirstInteraction = 0;

		// whether or not we're enabled
		var enabled = true;

		/**
		 * requestAnimationFrame callback
		 */
		function interact(e, now) {
			now = now || BOOMR.now();

			if (!enabled) {
				return;
			}

			if (!timeToFirstInteraction) {
				timeToFirstInteraction = now;
			}

			// increment the FPS
			t.increment("interaction");
		}

		/**
		 * Analyzes Interactions
		 */
		function analyze(startTime) {
			impl.addToBeacon("c.ttfi", externalMetrics.timeToFirstInteraction());
		}

		/**
		 * Disables the monitor
		 */
		function stop() {
			enabled = false;
		}

		//
		// External metrics
		//
		externalMetrics.timeToFirstInteraction = function() {
			if (timeToFirstInteraction && p && p.timing && p.timing.navigationStart) {
				// milliseconds since nav start
				return timeToFirstInteraction - p.timing.navigationStart;
			}

			// no data
			return;
		};

		return {
			interact: interact,
			analyze: analyze,
			stop: stop
		};
	};

	// TODO Things to measure over time for the timeline:
	// 1. heap https://github.com/nicjansma/talks/blob/master/measuring-continuity/examples/heap-memory-usage.js
	// 2. battery level  https://github.com/nicjansma/talks/blob/master/measuring-continuity/examples/interactions-battery.js
	// 3. orientation https://github.com/nicjansma/talks/blob/master/measuring-continuity/examples/interactions-orientation.js
	// 4. visibility state https://github.com/nicjansma/talks/blob/master/measuring-continuity/examples/interactions-visibility.js
	// 5. resources fetched via perfobserver or getEntries().length
	// 6. mutation amount https://github.com/nicjansma/talks/blob/master/measuring-continuity/examples/size-mutations.js
	// 7. dom sizes https://github.com/nicjansma/talks/blob/master/measuring-continuity/examples/size-nodes.js
	// 8. errors
	// TODO: reset each monitor's stats on beacon?

	//
	// Continuity implementation
	//
	impl = {
		//
		// Members
		//
		/**
		 * Whether or not we're initialized
		 */
		initialized: false,

		/**
		 * Whether we're ready to send a beacon
		 */
		complete: false,

		/**
		 * Whether or not to monitor longTasks
		 */
		monitorLongTasks: true,

		/**
		 * Whether or not to monitor FPS
		 */
		monitorFrameRate: true,

		/**
		 * Whether or not to monitor interactions
		 */
		monitorInteractions: true,

		/**
		 * Whether to monitor after onload
		 */
		afterOnload: false,

		/**
		 * Whether to wait after onload
		 */
		waitAfterOnload: false,

		/**
		 * Whether or not to wait for a call to
		 * frameworkReady() before starting TTI calculations
		 */
		ttiWaitForFrameworkReady: false,

		/**
		 * Whether or not to wait for all configured hero images to have
		 * loaded before starting TTI calculations
		 */
		ttiWaitForHeroImages: false,

		/**
		 * Framework Ready time, if configured
		 */
		frameworkReady: null,

		/**
		 * Timeline
		 */
		timeline: null,

		/**
		 * LongTaskMonitor
		 */
		longTaskMonitor: null,

		/**
		 * FrameRateMonitor
		 */
		frameRateMonitor: null,

		/**
		 * InteractionMonitor
		 */
		interactionMonitor: null,

		/**
		 * ScrollMontior
		 */
		scrollMonitor: null,

		/**
		 * ClickMonitor
		 */
		clickMonitor: null,

		/**
		 * KeyMonitor
		 */
		keyMonitor: null,

		/**
		 * MouseMonitor
		 */
		mouseMonitor: null,

		/**
		 * Vars we added to the beacon
		 */
		addedVars: [],

		/**
		 * All possible monitors
		 */
		monitors: [
			"timeline",
			"longTaskMonitor",
			"frameRateMonitor",
			"scrollMonitor",
			"keyMonitor",
			"clickMonitor",
			"mouseMonitor",
			"interactionMonitor"
		],

		/**
		 * When we last sent a beacon
		 */
		timeOfLastBeacon: 0,

		/**
		 * Whether or not we've added data to this beacon
		 */
		hasAddedDataToBeacon: false,

		//
		// Callbacks
		//
		/**
		 * Callback before the beacon is going to be sent
		 */
		onBeforeBeacon: function() {
			impl.runAllAnalyzers();
		},

		/**
		 * Runs all analyzers
		 */
		runAllAnalyzers: function() {
			var i;

			if (impl.hasAddedDataToBeacon) {
				// don't add data twice
				return;
			}

			for (i = 0; i < impl.monitors.length; i++) {
				if (impl[impl.monitors[i]]) {
					impl[impl.monitors[i]].analyze(impl.timeOfLastBeacon);
				}
			}

			// keep track of when we last added data
			impl.timeOfLastBeacon = BOOMR.now();

			// note we've added data
			impl.hasAddedDataToBeacon = true;
		},

		/**
		 * Callback after the beacon is ready to send, so we can clear
		 * our added vars
		 */
		onBeacon: function() {
			var i;

			if (impl.addedVars && impl.addedVars.length > 0) {
				BOOMR.removeVar(impl.addedVars);

				impl.addedVars = [];
			}

			for (i = 0; i < impl.monitors.length; i++) {
				var monitor = impl[impl.monitors[i]];

				if (monitor) {
					// disable ourselves if we're not doing anything after the first beacon
					if (!impl.afterOnload) {
						if (typeof monitor.stop === "function") {
							monitor.stop();
						}
					}

					// notify all plugins that there's been a beacon
					if (typeof monitor.onBeacon === "function") {
						monitor.onBeacon();
					}
				}
			}

			// we haven't added data any more
			impl.hasAddedDataToBeacon = false;
		},

		/**
		 * Callback when the page is ready
		 */
		onPageReady: function() {
			if (impl.waitAfterOnload) {
				// TODO poll every X ms?
				setTimeout(function() {
					impl.runAllAnalyzers();

					impl.complete = true;

					BOOMR.sendBeacon();
				}, impl.waitAfterOnload);
			}
			else {
				impl.complete = true;
			}
		},

		//
		// Misc
		//
		/**
		 * Adds a variable to the beacon, tracking the names so we can
		 * remove them later.
		 *
		 * @param {string} name Name
		 * @param {string} val Value.  If 0 or undefined, the value is removed from the beacon.
		 */
		addToBeacon: function(name, val) {
			if (val === 0 || typeof val === "undefined") {
				BOOMR.removeVar(name);
				return;
			}

			BOOMR.addVar(name, val);

			impl.addedVars.push(name);
		}
	};

	//
	// External Plugin
	//
	BOOMR.plugins.Continuity = {
		init: function(config) {
			BOOMR.utils.pluginConfig(impl, config, "Continuity",
				["monitorLongTasks", "monitorFrameRate", "monitorInteractions",
					"afterOnload", "waitAfterOnload", "ttiWaitForFrameworkReady",
					"ttiWaitForHeroImages"]);

			if (impl.initialized) {
				return this;
			}

			impl.initialized = true;

			// create the timeline
			impl.timeline = new Timeline(BOOMR.now());

			//
			// Setup
			//
			if (BOOMR.window) {
				//
				// LongTasks
				//
				if (impl.monitorLongTasks && typeof BOOMR.window.PerformanceObserver === "function") {
					impl.longTaskMonitor = new LongTaskMonitor(BOOMR.window, impl.timeline);
				}

				//
				// FPS
				//
				if (impl.monitorFrameRate && typeof BOOMR.window.requestAnimationFrame === "function") {
					impl.frameRateMonitor = new FrameRateMonitor(BOOMR.window, impl.timeline);
				}

				//
				// Interactions
				//
				if (impl.monitorInteractions) {
					impl.interactionMonitor = new InteractionMonitor(BOOMR.window, impl.timeline);
					impl.scrollMonitor = new ScrollMonitor(BOOMR.window, impl.timeline, impl.interactionMonitor);
					impl.keyMonitor = new KeyMonitor(BOOMR.window, impl.timeline, impl.interactionMonitor);
					impl.clickMonitor = new ClickMonitor(BOOMR.window, impl.timeline, impl.interactionMonitor);
					impl.mouseMonitor = new MouseMonitor(BOOMR.window, impl.timeline, impl.interactionMonitor);
				}
			}

			// event handlers
			BOOMR.subscribe("before_beacon", impl.onBeforeBeacon, null, impl);
			BOOMR.subscribe("onbeacon", impl.onBeacon, null, impl);
			BOOMR.subscribe("page_ready", impl.onPageReady, null, impl);

			return this;
		},

		is_complete: function() {
			return impl.complete;
		},

		/**
		 * Signal that the framework is ready
		 */
		frameworkReady: function() {
			impl.frameworkReady = BOOMR.now();
		},

		// external metrics
		metrics: externalMetrics
	};
}());
