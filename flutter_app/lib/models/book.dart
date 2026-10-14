class Book {
  final int? id;
  final int? libraryId;
  final String isbn;
  final String title;
  final String authors;
  final String? cover;
  final String? publisher;
  final String? published;
  final String? createdAt;

  Book({
    this.id,
    this.libraryId,
    required this.isbn,
    required this.title,
    required this.authors,
    this.cover,
    this.publisher,
    this.published,
    this.createdAt,
  });

  factory Book.fromJson(Map<String, dynamic> j) {
    return Book(
      id: _asIntOrNull(j['id']),
      libraryId: _asIntOrNull(j['library_id']),
      isbn: (j['isbn'] ?? '').toString(),
      title: (j['title'] ?? '未知书名').toString(),
      authors: (j['authors'] ?? '未知作者').toString(),
      cover: j['cover']?.toString(),
      publisher: j['publisher']?.toString(),
      published: j['published']?.toString(),
      createdAt: j['created_at']?.toString(),
    );
  }

  Map<String, dynamic> toAddBody(int libraryId) => {
        'library_id': libraryId,
        'isbn': isbn,
        'title': title,
        'authors': authors,
        'cover': cover,
        'publisher': publisher,
        'published': published,
      };
}

class CheckResult {
  final bool exists;
  final Book? book;
  final BookMeta? meta;
  final String? isbn;

  CheckResult({
    required this.exists,
    this.book,
    this.meta,
    this.isbn,
  });

  factory CheckResult.fromJson(Map<String, dynamic> j) {
    return CheckResult(
      exists: j['exists'] == true,
      book: j['book'] is Map ? Book.fromJson(Map<String, dynamic>.from(j['book'])) : null,
      meta: j['meta'] is Map ? BookMeta.fromJson(Map<String, dynamic>.from(j['meta'])) : null,
      isbn: j['isbn']?.toString(),
    );
  }
}

class BookMeta {
  final String? title;
  final String? authors;
  final String? cover;
  final String? publisher;
  final String? published;

  BookMeta({
    this.title,
    this.authors,
    this.cover,
    this.publisher,
    this.published,
  });

  factory BookMeta.fromJson(Map<String, dynamic> j) {
    return BookMeta(
      title: j['title']?.toString(),
      authors: j['authors']?.toString(),
      cover: j['cover']?.toString(),
      publisher: j['publisher']?.toString(),
      published: j['published']?.toString(),
    );
  }
}

int? _asIntOrNull(dynamic v) {
  if (v == null) return null;
  if (v is int) return v;
  return int.tryParse(v.toString());
}
