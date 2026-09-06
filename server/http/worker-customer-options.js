const { pinyin } = require('pinyin-pro');

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function nameMatches(name, query) {
  const text = normalize(name);
  if (text.includes(query)) return true;
  // Chinese queries match written characters, not unrelated homophones.
  if (/[^a-z0-9üv]/.test(query)) return false;
  return ['pinyin', 'first'].some(pattern => normalize(pinyin(text, {
    toneType: 'none', pattern, nonZh: 'consecutive', v: true
  })).includes(query));
}

function workerCustomerOptions(db, workerId, search) {
  const query = normalize(search);
  if (!workerId || !query || query.length > 100) return [];
  const rows = db.prepare(`SELECT c.id AS customerId,c.name AS customerName,a.id AS addressId,
    a.address,COALESCE(NULLIF(a.contact_name,''),c.contact,'') AS contact,
    COALESCE(NULLIF(a.contact_phone,''),c.phone,'') AS phone,r.name AS areaName
    FROM customer_addresses a JOIN customers c ON c.id=a.customer_id JOIN areas r ON r.id=a.area_id
    WHERE c.status<>'disabled' AND a.is_active=1 AND trim(a.address)<>''
      AND EXISTS (SELECT 1 FROM area_workers aw WHERE aw.area_id=a.area_id AND aw.worker_id=?)
    ORDER BY c.name,a.is_common DESC,a.id`).all(workerId);
  const matching = new Map();
  return rows.filter(row => {
    if (!matching.has(row.customerId)) matching.set(row.customerId, nameMatches(row.customerName, query));
    return matching.get(row.customerId);
  }).slice(0, 50);
}

module.exports = { workerCustomerOptions };
