import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, X, Tag } from 'lucide-react';
import { useCategories, useProducts, addCategory, updateCategory, deleteCategory } from '@/lib/hooks';
import type { Category } from '@/lib/supabase';

export default function CategoriesPage() {
  const { categories, loading } = useCategories();
  const { products } = useProducts();

  const productCountByCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const product of products) {
      if (product.category_id) counts.set(product.category_id, (counts.get(product.category_id) || 0) + 1);
    }
    return counts;
  }, [products]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  function openNew() {
    setEditing(null);
    setName('');
    setShowForm(true);
  }

  function openEdit(cat: Category) {
    setEditing(cat);
    setName(cat.name);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Kategori adı gerekli'); return; }
    if (editing) {
      await updateCategory(editing.id, name.trim());
    } else {
      await addCategory(name.trim());
    }
    setShowForm(false);
    setEditing(null);
    setName('');
  }

  async function handleDelete(cat: Category) {
    if (confirm(`"${cat.name}" kategorisini silmek istiyor musunuz?`)) {
      await deleteCategory(cat.id);
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-800">Kategori Yönetimi</h1>
            <p className="text-sm text-slate-500">{categories.length} kategori</p>
          </div>
          <button onClick={openNew} className="btn-primary px-4 py-2">
            <Plus size={18} />
            Yeni Kategori
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex h-full items-center justify-center text-slate-400">Yükleniyor...</div>
        ) : categories.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
            <Tag size={48} />
            <p>Henüz kategori yok</p>
            <button onClick={openNew} className="btn-primary">İlk kategoriyi ekleyin</button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {categories.map((cat) => (
              <div key={cat.id} className="card flex items-center gap-3 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-100">
                  <Tag className="text-teal-600" size={20} />
                </div>
                <div className="flex-1">
                  <p className="font-medium text-slate-800">{cat.name}</p>
                  <p className="text-xs text-slate-400">{productCountByCategory.get(cat.id) || 0} ürün · Sıra: {cat.sort_order}</p>
                </div>
                <button onClick={() => openEdit(cat)} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-teal-600">
                  <Pencil size={16} />
                </button>
                <button onClick={() => handleDelete(cat)} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500">
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={() => setShowForm(false)}>
          <div className="card w-full max-w-sm p-6 animate-slide-up" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-800">{editing ? 'Kategori Düzenle' : 'Yeni Kategori'}</h2>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600">
                <X size={22} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Kategori Adı</label>
                <input className="input" value={name} onChange={(e) => { setName(e.target.value); setError(''); }} autoFocus />
              </div>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowForm(false)} className="btn-secondary flex-1 py-2.5">İptal</button>
                <button type="submit" className="btn-primary flex-1 py-2.5">{editing ? 'Güncelle' : 'Ekle'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
