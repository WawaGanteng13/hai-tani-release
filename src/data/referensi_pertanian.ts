/**
 * Korpus referensi pertanian terverifikasi (starter, dikurasi).
 * Dipakai asisten agronomi agenik: jawaban Q&A + padanan foto WAJIB merujuk
 * entri ini (kode [REF-xxx]) bila relevan, dan selalu ditutup eskalasi PPL.
 * Dosis = kisaran umum acuan Balitbangtan/BBPOPT/Kementan; label kemasan +
 * PPL setempat adalah otoritas final. Korpus diperluas bertahap.
 */
export interface RefPertanian {
  id: string;
  kategori: "hama" | "penyakit" | "pupuk" | "gulma" | "umum";
  komoditas: string[];
  kunci: string[];
  judul: string;
  isi: string;
  sumber: string;
}

const S = "Acuan umum Balitbangtan/BBPOPT/Kementan — konfirmasi ke PPL setempat.";

export const REFERENSI_PERTANIAN: RefPertanian[] = [
  {
    id: "REF-001", kategori: "hama", komoditas: ["padi"],
    kunci: ["wereng", "coklat", "nilaparvata", "hopperburn", "daun menguning", "rumpun kerdil"],
    judul: "Wereng batang coklat (padi)",
    isi: "Gejala: daun menguning lalu mengering dari pangkal (hopperburn), rumpun kerdil. Ambang kendali: rata-rata 1 ekor/rumpun. PHT: tanam serentak, atur jarak tanam, jaga musuh alami (laba-laba, kepik). Insektisida berbahan aktif pymetrozine/BPMC bila ambang terlampaui, semprot pagi/sore, ikuti dosis label.",
    sumber: S,
  },
  {
    id: "REF-002", kategori: "hama", komoditas: ["padi"],
    kunci: ["sundep", "beluk", "penggerek batang", "pucuk layu", "malai putih", "anakan mati"],
    judul: "Sundep/beluk — penggerek batang padi",
    isi: "Gejala: pucuk anakan layu lalu mati (sundep); malai putih hampa (beluk). PHT: tanam serentak, sanitasi tunggul, pasang perangkap lampu, rilis parasitoid Trichogramma. Insektisida sistemik (bahan aktif karbofuran alternatif: fipronil/klorantraniliprol) bila >10% rumpun terserang, ikuti label.",
    sumber: S,
  },
  {
    id: "REF-003", kategori: "penyakit", komoditas: ["padi"],
    kunci: ["blas", "pyricularia", "bercak belah ketupat", "leher malai busuk", "neck blast"],
    judul: "Blas (Pyricularia oryzae)",
    isi: "Gejala: bercak daun berbentuk belah ketupat tepi coklat; blas leher membuat malai patah/busuk. Kendali: varietas tahan, kurangi urea berlebih, atur pengairan (jangan genangan terus). Fungisida (trisiklazol/isoprotiolan) saat gejala awal, ulangi sesuai label, hentikan 2 minggu sebelum panen.",
    sumber: S,
  },
  {
    id: "REF-004", kategori: "penyakit", komoditas: ["padi"],
    kunci: ["kresek", "hawar daun", "xanthomonas", "daun bergaris basah", "tepi daun kering"],
    judul: "Hawar daun bakteri / kresek (Xoo)",
    isi: "Gejala: garis basah di tepi daun lalu mengering keputihan (kresek). Kendali: benih sehat/bersertifikat, hindari luka mekanis, keringkan petakan berkala. Bakterisida tembaga bila perlu; tidak ada fungisida yang mempan karena ini bakteri — jangan buang biaya semprot fungisida.",
    sumber: S,
  },
  {
    id: "REF-005", kategori: "penyakit", komoditas: ["padi"],
    kunci: ["tungro", "daun oranye", "kerdil", "wereng hijau"],
    judul: "Tungro (virus, vektor wereng hijau)",
    isi: "Gejala: daun muda kuning-oranye, anakan kerdil, malai kecil. Virus tidak bisa disembuhkan: cabut dan bakar rumpun sakit, kendalikan wereng hijau vektornya, tanam serentak dan varietas tahan (Inpari series tahan tungro). Fokus ke pencegahan musim berikut.",
    sumber: S,
  },
  {
    id: "REF-006", kategori: "hama", komoditas: ["padi", "jagung"],
    kunci: ["tikus", "tikus sawah", "rumpun dipotong", "lubang tikus", "gropyokan"],
    judul: "Tikus sawah (PHT kawasan)",
    isi: "Kendali harus serentak sekawasan: gropyokan, pemasangan bubu perangkap (trap barrier system) di musim tanam, sanitasi tanggul/selokan, burung hantu (Tyto alba) sebagai predator. Umpan beracun (rodentisida) hanya bila populasi tinggi, jauh dari panen, jauh dari ternak/air minum.",
    sumber: S,
  },
  {
    id: "REF-007", kategori: "hama", komoditas: ["padi"],
    kunci: ["keong mas", "keong", "telur merah muda", "daun bibit habis"],
    judul: "Keong mas",
    isi: "Gejala: bibit muda habis dimakan, telur merah muda di pematang. Kendali: pungut manual + telur, pasang saringan saluran masuk, keringkan petakan 3-5 hari setelah tanam, tanam bibit umur >21 hari (lebih tahan). Moluskisida hanya bila serangan berat.",
    sumber: S,
  },
  {
    id: "REF-008", kategori: "pupuk", komoditas: ["padi"],
    kunci: ["pupuk padi", "dosis padi", "urea padi", "npk padi", "pemupukan padi"],
    judul: "Takaran pupuk padi sawah (per hektar)",
    isi: "Acuan berimbang per ha: Urea 225 kg, NPK Phonska (15-15-15) 300 kg, pupuk organik 1000 kg, SP-36 50 kg. Bagi 2-3 aplikasi: dasar (olah tanah), susulan I (21 HST), susulan II (42 HST). Sesuaikan hasil uji tanah (PUTS); kurangi urea bila riwayat blas/kresek.",
    sumber: "Kalkulator Hai Tani, acuan Balitbangtan — konfirmasi ke PPL setempat.",
  },
  {
    id: "REF-009", kategori: "hama", komoditas: ["jagung"],
    kunci: ["ulat grayak", "frugiperda", "armyworm", "daun berlubang", "pucuk jagung rusak", "kotoran ulat"],
    judul: "Ulat grayak frugiperda (jagung)",
    isi: "Gejala: daun muda berlubang tidak beraturan, kotoran ulat di pucuk. Kendali: pantau sejak 2 MST, musuh alami (Telenomus), perangkap feromon. Insektisida (emamektin benzoat/spinetoram) semprot ke pucuk sore hari bila >20% tanaman terserang. Rotasi bahan aktif tiap musim.",
    sumber: S,
  },
  {
    id: "REF-010", kategori: "penyakit", komoditas: ["jagung"],
    kunci: ["bulai", "downy mildew", "daun bergaris putih", "peronosclerospora"],
    judul: "Bulai (downy mildew jagung)",
    isi: "Gejala: garis putih-kuning sejajar tulang daun, tanaman kerdil. Kendali utama: benih tahan + perlakuan benih (seed treatment metalaksil). Tanaman sakit berat dicabut-dibakar. Fungisida semprot kurang efektif bila sudah sistemik — pencegahan via benih jauh lebih murah.",
    sumber: S,
  },
  {
    id: "REF-011", kategori: "pupuk", komoditas: ["jagung"],
    kunci: ["pupuk jagung", "dosis jagung", "urea jagung", "pemupukan jagung"],
    judul: "Takaran pupuk jagung (per hektar)",
    isi: "Kisaran umum per ha: Urea 300-350 kg, NPK 200-300 kg, organik 1000 kg, dibagi susulan umur 3-4 MST dan 6-7 MST di samping barisan lalu timbun. Gunakan kalkulator dosis Hai Tani untuk angka per-luas lahan. Uji tanah bila hasil stagnan 2 musim.",
    sumber: S,
  },
  {
    id: "REF-012", kategori: "penyakit", komoditas: ["cabai", "cabe"],
    kunci: ["antraknosa", "patek", "buah busuk", "bercak cekung", "colletotrichum"],
    judul: "Antraknosa/patek (cabai)",
    isi: "Gejala: bercak cekung kehitaman pada buah, meluas saat lembap. Kendali: petik-buang buah sakit (jangan dibuang di bedengan), atur jarak tanam + drainase, mulsa plastik. Fungisida (mankozeb/azosistrobin, rotasi) mulai pembungaan; patuhi interval sebelum panen di label.",
    sumber: S,
  },
  {
    id: "REF-013", kategori: "penyakit", komoditas: ["cabai", "cabe", "bawang"],
    kunci: ["layu fusarium", "fusarium", "layu siang segar pagi", "pangkal batang busuk"],
    judul: "Layu fusarium",
    isi: "Gejala khas: layu siang hari, segar pagi, akhirnya mati; pangkal batang coklat. Patogen tular tanah: rotasi tanaman, bedengan tinggi + drainase, benih/media steril, agen hayati Trichoderma. Tanaman sakit dicabut-dibakar; fungisida kimia hanya menekan, jarang menyembuhkan.",
    sumber: S,
  },
  {
    id: "REF-014", kategori: "hama", komoditas: ["cabai", "cabe"],
    kunci: ["thrips", "kutu daun", "trips", "daun keriting", "pucuk keriting", "virus kuning", "aphid"],
    judul: "Thrips dan kutu daun (cabai, vektor virus)",
    isi: "Gejala: pucuk/daun muda keriting, pertumbuhan terhambat; keduanya menularkan virus kuning/kerdil. Kendali: perangkap kuning, musuh alami, sanitasi gulma inang. Insektisida selektif (abamektin/spinetoram) sore hari, rotasi bahan aktif. Tanaman bergejala virus berat dicabut.",
    sumber: S,
  },
  {
    id: "REF-015", kategori: "pupuk", komoditas: ["cabai", "cabe"],
    kunci: ["pupuk cabai", "dosis cabai", "pemupukan cabai", "npk cabai"],
    judul: "Takaran pupuk cabai (per hektar)",
    isi: "Kisaran umum per ha: pupuk dasar organik 10-20 ton + NPK 400-600 kg (campur bedengan), susulan NPK/KNO3 tiap 7-10 hari via kocor. Gunakan kalkulator dosis Hai Tani untuk angka per-luas. Tambah Ca/B bila ujung buah busuk (blossom end rot).",
    sumber: S,
  },
  {
    id: "REF-016", kategori: "hama", komoditas: ["bawang"],
    kunci: ["pengorok daun", "liriomyza", "liromyza", "daun bergaris putih berliku", "grandong"],
    judul: "Pengorok daun / grandong (bawang merah)",
    isi: "Gejala: liukan putih berliku di daun (larva di dalam jaringan). Kendali: petik-buang daun terserang berat, perangkap kuning, jaga musuh alami (parasitoid). Insektisida translaminar (abamektin/siromazin) pagi hari; semprot kontak biasa kurang tembus — pilih bahan yang tepat.",
    sumber: S,
  },
  {
    id: "REF-017", kategori: "penyakit", komoditas: ["bawang"],
    kunci: ["molner", "layu bawang", "umbi busuk", "alternaria porri", "bercak ungu", "trotol"],
    judul: "Bercak ungu/trotol (Alternaria porri, bawang)",
    isi: "Gejala: bercak ungu keabuan memanjang, daun mengering dari ujung (trotol). Kendali: benih/bibit sehat, rotasi, bedengan tidak becek. Fungisida (mankozeb/klorotalonil, rotasi) saat gejala awal, interval 5-7 hari saat musim hujan. Umbi untuk bibit dipilih dari tanaman sehat.",
    sumber: S,
  },
  {
    id: "REF-018", kategori: "pupuk", komoditas: ["bawang"],
    kunci: ["pupuk bawang", "dosis bawang", "pemupukan bawang", "npk bawang"],
    judul: "Takaran pupuk bawang merah (per hektar)",
    isi: "Kisaran umum per ha: organik 10-15 ton + NPK 300-400 kg + ZA/Urea 150-200 kg sebagai susulan umur 3-5 MST. Gunakan kalkulator dosis Hai Tani untuk angka per-luas. Kurangi N bila serangan penyakit daun tinggi; pastikan drainase baik.",
    sumber: S,
  },
  {
    id: "REF-019", kategori: "gulma", komoditas: ["padi", "jagung", "cabai", "bawang"],
    kunci: ["gulma", "rumput liar", "penyiangan", "herbisida", "eceng", "teki"],
    judul: "Pengendalian gulma (umum)",
    isi: "Kunci: kendalikan 2-4 MST pertama (periode kritis). Mekanis: penyiangan/osrok + rendam dangkal (padi). Herbisida pra-tumbuh (pre-emergence) segera setelah tanam atau purna-tumbuh selektif sesuai label; jangan campur dosis berlebih — meracuni tanaman dan tanah. Rotasi cara kendali tiap musim.",
    sumber: S,
  },
  {
    id: "REF-020", kategori: "pupuk", komoditas: ["padi", "jagung", "cabai", "bawang"],
    kunci: ["pupuk organik", "kompos", "pupuk kandang", "pembenah tanah", "bokashi"],
    judul: "Pupuk organik dan pembenah tanah",
    isi: "Dosis umum: kompos/pupuk kandang matang 5-10 ton/ha/musim (sayuran hingga 20 ton), campur saat olah tanah. Wajib MATANG (tidak berbau, remah) agar tidak membawa patogen/biji gulma. Kombinasikan dengan anorganik (berimbang), bukan mengganti total dalam sekali musim.",
    sumber: S,
  },
  {
    id: "REF-021", kategori: "umum", komoditas: ["padi", "jagung", "cabai", "bawang"],
    kunci: ["uji tanah", "puts", "ph tanah", "tanah masam", "pengapuran", "dolomit", "kapur"],
    judul: "Uji tanah (PUTS) dan pengapuran",
    isi: "Bila hasil stagnan padahal pupuk cukup: uji pH + hara via PUTS/dinas (gratis/murah). Tanah masam (pH <5,5): kapur dolomit 1-2 ton/ha, beri 2-4 minggu sebelum tanam. Jangan tambah urea saat pH masalah — pupuk tak terserap dan penyakit daun makin parah.",
    sumber: S,
  },
  {
    id: "REF-022", kategori: "umum", komoditas: ["padi", "jagung", "cabai", "bawang"],
    kunci: ["apd", "keamanan pestisida", "keracunan", "interval panen", "pre harvest interval", "mencampur pestisida"],
    judul: "Aman menggunakan pestisida",
    isi: "Wajib: baca label, APD (masker, sarung tangan, baju lengan panjang), semprot pagi/sore tidak berangin, JANGAN makan/minum/merokok saat aplikasi, cuci tangan+alat sesudahnya. Patuhi interval sebelum panen di label. Simpan terkunci jauh dari anak/ternak/pangan. Bila pusing/mual: hentikan, ke Puskesmas, bawa kemasan.",
    sumber: "Prinsip PHT Kementan — konfirmasi ke PPL setempat.",
  },
  {
    id: "REF-023", kategori: "hama", komoditas: ["agave", "tanaman hias", "hias"],
    kunci: ["kutu sisik", "sisik", "scale", "daun lengket", "embun jelaga", "mealybug", "kutu putih"],
    judul: "Kutu sisik/kutu putih (tanaman hias, agave)",
    isi: "Gejala: benjolan sisik/serbuk putih di daun-batang, daun lengket lalu hitam (embun jelaga). Kendali: sikat + air sabun untuk serangan ringan, pangkas bagian parah, perbaiki sirkulasi udara. Insektisida (minyak nimba/abamektin) bila meluas; ulangi 7 hari untuk telur yang menetas susulan.",
    sumber: S,
  },
  {
    id: "REF-024", kategori: "penyakit", komoditas: ["agave", "tanaman hias", "hias"],
    kunci: ["busuk akar", "busuk pangkal", "overwatering", "daun lembek", "media becek", "layu hias"],
    judul: "Busuk akar/pangkal (agave & hias)",
    isi: "Penyebab umum: media becek + pot tanpa drainase. Gejala: daun bawah lembek menguning, pangkal lunak berbau. Kendali: bongkar, buang akar busuk, angin-anginkan, tanam ulang di media porous (pasir malang/sekam bakar), siram hanya saat media kering. Fungisida hanya pendamping; drainase adalah obatnya.",
    sumber: S,
  },
];
