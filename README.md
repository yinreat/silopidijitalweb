# Silopi Dijital ProPOS 5.6.4 — Değerlendirme Demo

Bu sürüm yazılımcı incelemesi ve puanlaması içindir. Site açıldığında otomatik olarak giriş yapar ve yalnızca kurgusal `PROPOS DEMO MARKET` işletmesinin örnek kayıtlarını gösterir. Gerçek müşteri verisi veya Yunus ProPOS kişisel verisi bu demoya bağlanmamıştır.

## Neden 100 dosya hatası alıyorsun?

GitHub'ın web sayfasındaki dosya yükleme aracı tek seferde en fazla 100 dosyayı kabul eder. Bu projeyi dosyaları tek tek web sayfasına sürükleyerek yükleme. **GitHub Desktop** kullan; tüm proje tek commit olarak gönderilir ve 100 dosya sınırına takılmaz.

## GitHub Desktop ile yükleme

1. GitHub Desktop'ı kur ve GitHub hesabına giriş yap.
2. `File → Add Local Repository` seç.
3. Bu klasörü seç. Henüz Git deposu değilse `Create a repository` ile aynı klasörde depo oluştur.
4. Summary alanına `ProPOS 5.6.4 evaluation demo` yaz.
5. `Commit to main` ve ardından `Publish repository` seç.
6. Değerlendirecek kişiye açık bir bağlantı göndereceksen depoyu public yapabilirsin.

## Vercel'e yayınlama

1. Vercel hesabında `Add New → Project` seç.
2. GitHub deposunu içe aktar.
3. Root Directory: `./`
4. Framework Preset: `Vite`
5. Build Command: `npm run build`
6. Output Directory: `dist`
7. Deploy.

`vercel.json` bu değerleri otomatik ayarlar. `.env.demo` dosyası Vite tarafından `demo` modunda yüklenir; Vercel'de ayrıca ortam değişkeni tanımlaman gerekmez.

## Yerelde çalıştırma

```powershell
npm install
npm run dev
```

Üretim derlemesi: `npm run build` — çıktı `dist/` klasörüne yazılır.

## Değerlendirme girişi

- Site otomatik olarak `Değerlendirme Yöneticisi` hesabıyla açılır.
- Personel değiştir/çıkış ekranına girilirse demo PIN: `0000`.
- Uygulama ürün ekleme, fiyat/stok değiştirme ve satış gibi işlemleri ortak demo işletmesinde saklar. Birden fazla değerlendiren aynı siteyi kullanırsa yaptıkları işlemler birbirini etkileyebilir.
- Demo token herkese açıktır; sadece kurgusal demo tenant'a erişir. Bu yapı gerçek mağazada, gerçek müşteri verisiyle veya ticari kullanımda kullanılmamalıdır.

## Windows EXE'den farkı

Bu paket yalnızca web değerlendirme sürümüdür. Electron ve yerel SQLite dosyaları çıkarılmıştır. Orijinal Windows EXE kaynak akışı ayrı kalır; bu demoda yapılan işlemler EXE'ye veya gerçek müşteri verilerine aktarılmaz.
