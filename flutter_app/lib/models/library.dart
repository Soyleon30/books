class Library {
  final int id;
  final String name;
  final String? description;
  final int bookCount;
  final String? createdAt;

  Library({
    required this.id,
    required this.name,
    this.description,
    this.bookCount = 0,
    this.createdAt,
  });

  factory Library.fromJson(Map<String, dynamic> j) {
    return Library(
      id: _asInt(j['id']),
      name: (j['name'] ?? '').toString(),
      description: j['description']?.toString(),
      bookCount: _asInt(j['book_count']),
      createdAt: j['created_at']?.toString(),
    );
  }
}

int _asInt(dynamic v) {
  if (v == null) return 0;
  if (v is int) return v;
  return int.tryParse(v.toString()) ?? 0;
}
