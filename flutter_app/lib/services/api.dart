import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/book.dart';
import '../models/library.dart';

class ApiException implements Exception {
  final String message;
  final int? status;
  final Map<String, dynamic>? data;

  ApiException(this.message, {this.status, this.data});

  @override
  String toString() => message;
}

class ApiClient {
  ApiClient({String? baseUrl})
      : baseUrl = _normalizeBase(baseUrl ?? const String.fromEnvironment(
          'API_BASE',
          defaultValue: 'http://host.docker.internal:3000/api',
        ));

  final String baseUrl;

  static String _normalizeBase(String url) {
    var u = url.trim();
    if (u.endsWith('/')) u = u.substring(0, u.length - 1);
    if (!u.endsWith('/api')) {
      if (u.contains('/api')) {
        // keep as-is
      } else {
        u = '$u/api';
      }
    }
    return u;
  }

  Uri _uri(String path, [Map<String, String>? query]) {
    final p = path.startsWith('/') ? path : '/$path';
    return Uri.parse('$baseUrl$p').replace(queryParameters: query);
  }

  Future<Map<String, dynamic>> _request(
    String method,
    String path, {
    Map<String, String>? query,
    Map<String, dynamic>? body,
  }) async {
    final uri = _uri(path, query);
    final headers = {'Content-Type': 'application/json', 'Accept': 'application/json'};
    late http.Response res;
    try {
      switch (method) {
        case 'GET':
          res = await http.get(uri, headers: headers).timeout(const Duration(seconds: 20));
          break;
        case 'POST':
          res = await http
              .post(uri, headers: headers, body: jsonEncode(body ?? {}))
              .timeout(const Duration(seconds: 20));
          break;
        case 'PUT':
          res = await http
              .put(uri, headers: headers, body: jsonEncode(body ?? {}))
              .timeout(const Duration(seconds: 20));
          break;
        case 'DELETE':
          res = await http.delete(uri, headers: headers).timeout(const Duration(seconds: 20));
          break;
        default:
          throw ApiException('未知请求方法');
      }
    } catch (e) {
      if (e is ApiException) rethrow;
      throw ApiException('网络错误：$e');
    }

    Map<String, dynamic> data = {};
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) {
        data = decoded;
      } else if (decoded is Map) {
        data = Map<String, dynamic>.from(decoded);
      }
    } catch (_) {}

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(
        (data['error'] ?? res.reasonPhrase ?? '请求失败').toString(),
        status: res.statusCode,
        data: data,
      );
    }
    return data;
  }

  Future<bool> health() async {
    final data = await _request('GET', '/health');
    return data['ok'] == true;
  }

  Future<List<Library>> getLibraries() async {
    final data = await _request('GET', '/libraries');
    final list = data['libraries'];
    if (list is! List) return [];
    return list
        .whereType<Map>()
        .map((e) => Library.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  Future<Library> createLibrary({required String name, String? description}) async {
    final data = await _request('POST', '/libraries', body: {
      'name': name,
      'description': description ?? '',
    });
    return Library.fromJson(Map<String, dynamic>.from(data['library'] as Map));
  }

  Future<Library> updateLibrary(int id, {required String name, String? description}) async {
    final data = await _request('PUT', '/libraries/$id', body: {
      'name': name,
      'description': description ?? '',
    });
    return Library.fromJson(Map<String, dynamic>.from(data['library'] as Map));
  }

  Future<void> deleteLibrary(int id) async {
    await _request('DELETE', '/libraries/$id');
  }

  Future<CheckResult> checkBook(String isbn, int libraryId) async {
    final data = await _request(
      'GET',
      '/books/check/${Uri.encodeComponent(isbn)}',
      query: {'library_id': '$libraryId'},
    );
    return CheckResult.fromJson(data);
  }

  Future<Book> addBook(Map<String, dynamic> body) async {
    final data = await _request('POST', '/books', body: body);
    return Book.fromJson(Map<String, dynamic>.from(data['book'] as Map));
  }

  Future<List<Book>> getBooks({
    required int libraryId,
    String q = '',
    int limit = 100,
  }) async {
    final data = await _request('GET', '/books', query: {
      'library_id': '$libraryId',
      'q': q,
      'limit': '$limit',
    });
    final list = data['books'];
    if (list is! List) return [];
    return list
        .whereType<Map>()
        .map((e) => Book.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  Future<void> deleteBook(String isbn, int libraryId) async {
    await _request(
      'DELETE',
      '/books/${Uri.encodeComponent(isbn)}',
      query: {'library_id': '$libraryId'},
    );
  }
}

String normalizeIsbn(String s) {
  return s.replaceAll(RegExp(r'[^0-9Xx]'), '').toUpperCase();
}

bool isLikelyIsbn(String s) {
  final n = normalizeIsbn(s);
  return n.length == 10 || n.length == 13;
}
