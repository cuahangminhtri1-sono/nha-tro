/* ============================================================
   Service Worker — Sổ Nợ + Bán hàng
   Nhiệm vụ: cho app MỞ được khi mất mạng (cache khung app + thư viện).
   Firestore/Auth tự lo phần dữ liệu offline + tự đồng bộ — SW KHÔNG đụng vào.
   ------------------------------------------------------------
   ⚠️ MỖI LẦN SỬA index.html rồi deploy lại: đổi số VERSION bên dưới
      (vd 'v5' -> 'v6') để xoá cache cũ và nạp bản mới cho chắc.
   ------------------------------------------------------------
   v6: Bán/Trả/Nhập chạy offline + In tem đa máy in; thêm JsBarcode vào PRECACHE.
   v7: index.html có bộ TỰ CẬP NHẬT. Deploy đợt NÀY (đổi v6->v7) để các máy đang chạy bản cũ
       nhận nút "Cập nhật" một lần cuối; từ sau đó máy khách tự cập nhật, không cần bấm.
   ============================================================ */
"use strict";

const VERSION = "v7";
const CACHE = "sono-app-" + VERSION;

// Khung app cần có sẵn để mở offline. Nạp "cố gắng hết sức":
// nếu một mục lỗi cũng không làm hỏng cả quá trình cài đặt.
const PRECACHE = [
  "./",
  "./index.html",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js"
];

// Các máy chủ dữ liệu Firebase — TUYỆT ĐỐI không cache, để Firestore/Auth
// tự xử lý online/offline và tự đồng bộ.
const BACKEND_HOSTS = [
  "firestore.googleapis.com",
  "firebase.googleapis.com",
  "firebaseinstallations.googleapis.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "www.googleapis.com"
];

// Thư viện gắn phiên bản cố định (không đổi theo URL) -> cache-first vĩnh viễn.
function isVersionedLib(url) {
  return (url.hostname === "www.gstatic.com" && url.pathname.indexOf("/firebasejs/") !== -1)
      || url.hostname === "cdnjs.cloudflare.com"
      || url.hostname === "cdn.jsdelivr.net"
      || url.hostname === "esm.sh";
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Nạp từng mục riêng để một mục lỗi không phá cả mẻ.
    await Promise.all(PRECACHE.map(async (u) => {
      try {
        const res = await fetch(u, { cache: "no-cache" });
        if (res && (res.ok || res.type === "opaque")) {
          await cache.put(u, res.clone());
        }
      } catch (e) { /* bỏ qua mục nạp lỗi */ }
    }));
    // KHÔNG skipWaiting: để bản mới CHỜ, app sẽ hỏi người dùng "Cập nhật" rồi mới kích hoạt.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k.indexOf("sono-app-") === 0 && k !== CACHE) return caches.delete(k);
      return Promise.resolve();
    }));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Chỉ xử lý GET. Mọi ghi (POST/PUT...) để đi thẳng ra mạng.
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Không đụng vào dữ liệu Firebase — Firestore/Auth tự lo offline & đồng bộ.
  if (BACKEND_HOSTS.indexOf(url.hostname) !== -1) return;

  // Điều hướng (mở/tải lại trang) -> ưu tiên MẠNG nhưng KHÔNG chờ lâu khi sóng yếu:
  // đua mạng với 3.5 giây; quá hạn thì mở ngay bản đã lưu, đồng thời cập nhật ngầm cho lần sau.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = (await cache.match("./index.html")) || (await cache.match("./"));
      // Chỉ lưu trang khi tải THÀNH CÔNG (res.ok) -> tránh cache nhầm trang lỗi lúc deploy hỏng.
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put("./index.html", res.clone()).catch(() => {});
        return res;
      });
      if (cached) {
        const timeout = new Promise((r) => setTimeout(() => r(null), 3500));
        const winner = await Promise.race([net.catch(() => null), timeout]);
        if (winner && winner.ok) return winner;   // mạng nhanh & hợp lệ -> dùng bản mới
        event.waitUntil(net.catch(() => {}));      // để bản mạng chạy nốt, cập nhật cache
        return cached;                             // sóng yếu / lỗi / trang lỗi -> mở ngay bản đã lưu
      }
      try {
        return await net;                          // chưa có bản lưu -> buộc phải chờ mạng
      } catch (e) {
        return new Response("Đang ngoại tuyến và chưa có bản lưu. Hãy mở app khi có mạng một lần.", {
          status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    })());
    return;
  }

  // Thư viện phiên bản cố định (Firebase SDK, xlsx, JsBarcode...) -> cache-first + tự lưu khi tải.
  if (isVersionedLib(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === "opaque")) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // Tài nguyên cùng nguồn khác -> lấy cache trước, chạy nền cập nhật (stale-while-revalidate).
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
    return;
  }

  // Còn lại (vd ảnh QR VietQR) -> để mặc định đi ra mạng.
});
