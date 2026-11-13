// The original client uses this small HTTP surface. Fetch supplies the transport.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <type_traits>
using curl_off_t = int64_t;
using CURLcode = int;
constexpr int CURLE_OK = 0, CURLE_FAILED_INIT = 2, CURLE_ABORTED_BY_CALLBACK = 42, CURLE_HTTP_RETURNED_ERROR = 22;
enum { CURLOPT_USERAGENT, CURLOPT_URL, CURLOPT_WRITEFUNCTION, CURLOPT_WRITEDATA, CURLOPT_LOW_SPEED_TIME,
  CURLOPT_LOW_SPEED_LIMIT, CURLOPT_CONNECTTIMEOUT, CURLOPT_NOPROGRESS, CURLOPT_XFERINFOFUNCTION,
  CURLOPT_XFERINFODATA, CURLOPT_FOLLOWLOCATION };
struct CURL {
  std::string url;
  void *data = nullptr;
  size_t (*write)(void *, size_t, size_t, void *) = nullptr;
};
CURL *curl_easy_init();
void curl_easy_cleanup(CURL *);
CURLcode curl_easy_perform(CURL *);
const char *curl_easy_strerror(CURLcode);
template<class T> CURLcode curl_easy_setopt(CURL *h, int option, T value) {
  if (option == CURLOPT_URL) {
    if constexpr (std::is_convertible_v<T, const char *>) h->url = value;
  } else if (option == CURLOPT_WRITEDATA) {
    if constexpr (std::is_convertible_v<T, void *>) h->data = value;
  } else if (option == CURLOPT_WRITEFUNCTION) {
    if constexpr (std::is_function_v<std::remove_pointer_t<T>>) h->write = reinterpret_cast<decltype(h->write)>(value);
  }
  return CURLE_OK;
}
