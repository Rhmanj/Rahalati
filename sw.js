/* ============================================================
   Service Worker — يعمل في الخلفية حتى لو التطبيق مغلق
   يدير الإشعارات والتخزين المؤقت والتنبيهات المجدولة
   ============================================================ */

const CACHE_NAME = 'rahalati-v1';
const STORE_KEY = 'rahalati_v1';

// تثبيت Service Worker وتخزين الملفات
self.addEventListener('install', (event) => {
  console.log('[SW] تثبيت Service Worker');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        './',
        './رحلاتي.html',
        './manifest.json'
      ]).catch(() => {
        // قد لا تكون الملفات متاحة محلياً إذا كانت على الويب فقط
        console.log('[SW] بعض الملفات غير متاحة محلياً');
      });
    })
  );
  self.skipWaiting();
});

// تفعيل Service Worker
self.addEventListener('activate', (event) => {
  console.log('[SW] تفعيل Service Worker');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// معالجة الطلبات (شبكة أولاً ثم الكاش)
self.addEventListener('fetch', (event) => {
  // تخطّ طلبات non-GET
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // تخزين النسخة الجديدة
        if (response.ok && !response.url.includes('chrome-extension')) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, cloned);
          });
        }
        return response;
      })
      .catch(() => {
        // استخدام الكاش عند عدم توفر الشبكة
        return caches.match(event.request);
      })
  );
});

// معالجة نقرات الإشعارات
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] تم الضغط على إشعار:', event.notification.tag);
  event.notification.close();

  const urlToOpen = event.notification.data.url || './رحلاتي.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // ابحث عن نافذة مفتوحة بالفعل
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      // إن لم توجد نافذة، افتح واحدة جديدة
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// معالجة إجراءات الإشعارات (أزرار سريعة)
self.addEventListener('notificationclick', (event) => {
  if (event.action === 'open-app') {
    event.notification.close();
    event.waitUntil(clients.openWindow('./رحلاتي.html'));
  }
});

// استقبال رسائل من التطبيق الرئيسي
self.addEventListener('message', (event) => {
  const { type, data } = event.data;

  if (type === 'SEND_NOTIFICATION') {
    // إرسال إشعار من التطبيق
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" fill="%230E7C86"/><path d="M96 40 L130 80 L96 80 Z M80 120 Q80 100 96 100 Q112 100 112 120 L112 140 Q112 150 96 150 Q80 150 80 140 Z" fill="%23ffffff" opacity="0.9"/></svg>',
      badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="%230E7C86"/></svg>',
      tag: data.tag || 'notification',
      requireInteraction: data.requireInteraction || false,
      data: {
        url: data.url || './رحلاتي.html'
      },
      actions: [
        { action: 'open-app', title: 'فتح التطبيق' }
      ]
    });
  }

  if (type === 'SCHEDULE_NOTIFICATION') {
    // جدولة إشعار بعد تأخير معين
    const { delay, title, body, icon, tag, url } = data;
    setTimeout(() => {
      self.registration.showNotification(title, {
        body,
        icon: icon || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" fill="%230E7C86"/><path d="M96 40 L130 80 L96 80 Z M80 120 Q80 100 96 100 Q112 100 112 120 L112 140 Q112 150 96 150 Q80 150 80 140 Z" fill="%23ffffff" opacity="0.9"/></svg>',
        badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="%230E7C86"/></svg>',
        tag: tag || 'scheduled',
        requireInteraction: false,
        data: { url: url || './رحلاتي.html' },
        actions: [{ action: 'open-app', title: 'فتح التطبيق' }]
      });
    }, delay);
  }

  if (type === 'CHECK_REMINDERS') {
    // فحص التذكيرات المجدولة (تُستدعى دورياً)
    checkAndScheduleReminders();
  }
});

// فحص وجدولة التذكيرات
function checkAndScheduleReminders() {
  try {
    const store = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const trips = store.trips || [];
    const activeTrip = trips.find(t => t.id === store.activeTripId);

    if (!activeTrip) return;

    // آخر مرة أُرسل فيها تذكير يومي
    const lastReminder = localStorage.getItem('lastDailyReminder') || '0';
    const today = new Date().toDateString();
    
    if (lastReminder !== today) {
      // أرسل تذكير يومي مرة واحدة فقط
      self.registration.showNotification('تذكير: سجّل مصروفاتك', {
        body: `في رحلة "${activeTrip.name || 'بدون اسم'}" — هل أضفت المصروفات الجديدة؟`,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" fill="%230E7C86"/><path d="M96 40 L130 80 L96 80 Z M80 120 Q80 100 96 100 Q112 100 112 120 L112 140 Q112 150 96 150 Q80 150 80 140 Z" fill="%23ffffff" opacity="0.9"/></svg>',
        badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="%230E7C86"/></svg>',
        tag: 'daily-reminder',
        requireInteraction: false,
        data: { url: './رحلاتي.html' }
      });
      localStorage.setItem('lastDailyReminder', today);
    }
  } catch (e) {
    console.log('[SW] خطأ في فحص التذكيرات:', e);
  }
}

// بدء فحص التذكيرات بشكل دوري (كل ساعة)
setInterval(() => {
  checkAndScheduleReminders();
}, 3600000); // ساعة واحدة

console.log('[SW] Service Worker جاهز');
