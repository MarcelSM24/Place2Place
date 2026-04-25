#include <assert.h>
#include <bare.h>
#include <js.h>

#include <algorithm>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
#include <ctime>

#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>
#include <valhalla/baldr/graphid.h>
#include <valhalla/baldr/traffictile.h>
#include <valhalla/midgard/sequence.h>

#if __has_include(<valhalla/actor.h>)
#include <valhalla/actor.h>
using valhalla_actor_t = valhalla::Actor;
#else
#include <valhalla/tyr/actor.h>
using valhalla_actor_t = valhalla::tyr::actor_t;
#endif

namespace {

std::mutex g_actor_mutex;
std::unique_ptr<valhalla_actor_t> g_actor;
std::mutex g_traffic_mutex;

struct TrafficTileView {
  volatile valhalla::baldr::TrafficTileHeader* header;
  volatile valhalla::baldr::TrafficSpeed* speeds;
};

struct TrafficOverlayState {
  std::unique_ptr<valhalla::midgard::tar> archive;
  std::unordered_map<uint64_t, TrafficTileView> tiles;
};

std::unique_ptr<TrafficOverlayState> g_traffic;

js_value_t *throw_js_error(js_env_t *env, const char *message) {
  int err = js_throw_error(env, nullptr, message);
  assert(err == 0);
  return nullptr;
}

bool get_utf8_arg(js_env_t *env, js_value_t *value, std::string &out) {
  int err;
  size_t len = 0;

  err = js_get_value_string_utf8(env, value, nullptr, 0, &len);
  if (err != 0) return false;

  std::vector<char> buffer(len + 1, '\0');
  err = js_get_value_string_utf8(
      env, value, reinterpret_cast<utf8_t *>(buffer.data()), buffer.size(), nullptr);
  if (err != 0) return false;

  out.assign(buffer.data(), len);
  return true;
}

uint64_t parse_u64(const std::string& value) {
  if (value.empty()) throw std::invalid_argument("empty unsigned integer string");
  size_t parsed = 0;
  auto out = std::stoull(value, &parsed, 10);
  if (parsed != value.size()) throw std::invalid_argument("invalid unsigned integer string");
  return out;
}

js_value_t *init_valhalla(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, nullptr, nullptr);
  assert(err == 0);

  if (argc < 1) return throw_js_error(env, "initValhalla(configPath) requires a config path");

  std::string config_path;
  if (!get_utf8_arg(env, argv[0], config_path)) {
    return throw_js_error(env, "initValhalla(configPath) expects a UTF-8 string path");
  }

  try {
    boost::property_tree::ptree config;
    boost::property_tree::read_json(config_path, config);

    std::lock_guard<std::mutex> lock(g_actor_mutex);
    g_actor = std::make_unique<valhalla_actor_t>(config);
  } catch (const std::exception &e) {
    return throw_js_error(env, e.what());
  }

  js_value_t *undefined;
  err = js_get_undefined(env, &undefined);
  assert(err == 0);
  return undefined;
}

js_value_t *init_traffic_overlay(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, nullptr, nullptr);
  assert(err == 0);

  if (argc < 1) return throw_js_error(env, "initTrafficOverlay(trafficTarPath) requires a tar path");

  std::string traffic_tar_path;
  if (!get_utf8_arg(env, argv[0], traffic_tar_path)) {
    return throw_js_error(env, "initTrafficOverlay(trafficTarPath) expects a UTF-8 string path");
  }

  try {
    auto overlay = std::make_unique<TrafficOverlayState>();
    overlay->archive = std::make_unique<valhalla::midgard::tar>(traffic_tar_path, false);

    overlay->archive->for_each([&overlay](const std::string&, const char* data, size_t size) {
      if (size < sizeof(valhalla::baldr::TrafficTileHeader)) return true;

      auto* mutable_data = const_cast<char*>(data);
      auto* header =
          reinterpret_cast<volatile valhalla::baldr::TrafficTileHeader*>(mutable_data);

      if (header->traffic_tile_version != valhalla::baldr::TRAFFIC_TILE_VERSION) return true;

      const size_t bytes_needed = sizeof(valhalla::baldr::TrafficTileHeader) +
                                  static_cast<size_t>(header->directed_edge_count) *
                                      sizeof(valhalla::baldr::TrafficSpeed);
      if (bytes_needed > size) return true;

      auto* speeds =
          reinterpret_cast<volatile valhalla::baldr::TrafficSpeed*>(
              mutable_data + sizeof(valhalla::baldr::TrafficTileHeader));

      const uint64_t tile_id = header->tile_id;
      overlay->tiles[tile_id] = TrafficTileView{header, speeds};
      return true;
    });

    if (overlay->tiles.empty()) {
      return throw_js_error(env, "No traffic tiles found in traffic.tar overlay");
    }

    std::lock_guard<std::mutex> lock(g_traffic_mutex);
    g_traffic = std::move(overlay);
  } catch (const std::exception &e) {
    return throw_js_error(env, e.what());
  }

  js_value_t *undefined;
  err = js_get_undefined(env, &undefined);
  assert(err == 0);
  return undefined;
}

js_value_t *update_traffic_speed(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, nullptr, nullptr);
  assert(err == 0);

  if (argc < 2) {
    return throw_js_error(env, "updateTrafficSpeed(edgeId, speedKph) requires edge id and speed");
  }

  std::string edge_id_str;
  if (!get_utf8_arg(env, argv[0], edge_id_str)) {
    return throw_js_error(
        env, "updateTrafficSpeed(edgeId, speedKph) expects edgeId as string-compatible value");
  }

  uint32_t speed_kph = 0;
  err = js_get_value_uint32(env, argv[1], &speed_kph);
  if (err != 0) return throw_js_error(env, "updateTrafficSpeed(speedKph) expects uint8-compatible value");

  try {
    const uint64_t edge_id_raw = parse_u64(edge_id_str);
    const valhalla::baldr::GraphId edge_id(edge_id_raw);
    const uint64_t tile_key = edge_id.tile_value();
    const uint32_t local_edge_index = edge_id.id();

    std::lock_guard<std::mutex> lock(g_traffic_mutex);
    if (!g_traffic) return throw_js_error(env, "Traffic overlay not initialized. Call initTrafficOverlay() first.");

    auto it = g_traffic->tiles.find(tile_key);
    if (it == g_traffic->tiles.end()) return throw_js_error(env, "Traffic tile not found for edge tile id");

    auto& tile = it->second;
    if (local_edge_index >= tile.header->directed_edge_count) {
      return throw_js_error(env, "Edge index out of bounds for traffic tile");
    }

    auto* speed = tile.speeds + local_edge_index;

    const uint32_t clamped_kph = std::min<uint32_t>(
        speed_kph, valhalla::baldr::MAX_TRAFFIC_SPEED_KPH);
    const uint32_t encoded_speed = clamped_kph >> 1;

    // Use whole-edge aggregate speed for all traffic consumers.
    speed->overall_encoded_speed = encoded_speed;
    speed->encoded_speed1 = encoded_speed;
    speed->encoded_speed2 = 0;
    speed->encoded_speed3 = 0;
    speed->breakpoint1 = 255;
    speed->breakpoint2 = 0;
    speed->congestion1 = valhalla::baldr::UNKNOWN_CONGESTION_VAL;
    speed->congestion2 = valhalla::baldr::UNKNOWN_CONGESTION_VAL;
    speed->congestion3 = valhalla::baldr::UNKNOWN_CONGESTION_VAL;
    speed->spare = 0;

    tile.header->last_update = static_cast<uint64_t>(std::time(nullptr));
  } catch (const std::exception &e) {
    return throw_js_error(env, e.what());
  }

  js_value_t *undefined;
  err = js_get_undefined(env, &undefined);
  assert(err == 0);
  return undefined;
}

js_value_t *calculate_route(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, nullptr, nullptr);
  assert(err == 0);

  if (argc < 1) return throw_js_error(env, "calculateRoute(requestJson) requires a JSON request string");

  std::string request_json;
  if (!get_utf8_arg(env, argv[0], request_json)) {
    return throw_js_error(env, "calculateRoute(requestJson) expects a UTF-8 JSON string");
  }

  std::string response_json;
  try {
    std::lock_guard<std::mutex> lock(g_actor_mutex);
    if (!g_actor) return throw_js_error(env, "Valhalla actor is not initialized. Call initValhalla() first.");
    response_json = g_actor->route(request_json);
  } catch (const std::exception &e) {
    return throw_js_error(env, e.what());
  }

  js_value_t *result;
  err = js_create_string_utf8(
      env, reinterpret_cast<const utf8_t *>(response_json.c_str()), response_json.size(), &result);
  assert(err == 0);

  return result;
}

js_value_t *locate_point(js_env_t *env, js_callback_info_t *info) {
  int err;
  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, nullptr, nullptr);
  assert(err == 0);

  if (argc < 1) return throw_js_error(env, "locate(requestJson) requires a JSON request string");

  std::string request_json;
  if (!get_utf8_arg(env, argv[0], request_json)) {
    return throw_js_error(env, "locate(requestJson) expects a UTF-8 JSON string");
  }

  std::string response_json;
  try {
    std::lock_guard<std::mutex> lock(g_actor_mutex);
    if (!g_actor) return throw_js_error(env, "Valhalla actor is not initialized. Call initValhalla() first.");
    response_json = g_actor->locate(request_json);
  } catch (const std::exception &e) {
    return throw_js_error(env, e.what());
  }

  js_value_t *result;
  err = js_create_string_utf8(
      env, reinterpret_cast<const utf8_t *>(response_json.c_str()), response_json.size(), &result);
  assert(err == 0);

  return result;
}

js_value_t *valhalla_native_exports(js_env_t *env, js_value_t *exports) {
  int err;

  js_value_t *init_fn;
  err = js_create_function(env, "initValhalla", -1, init_valhalla, nullptr, &init_fn);
  assert(err == 0);
  err = js_set_named_property(env, exports, "initValhalla", init_fn);
  assert(err == 0);

  js_value_t *route_fn;
  err = js_create_function(env, "calculateRoute", -1, calculate_route, nullptr, &route_fn);
  assert(err == 0);
  err = js_set_named_property(env, exports, "calculateRoute", route_fn);
  assert(err == 0);

  js_value_t *locate_fn;
  err = js_create_function(env, "locate", -1, locate_point, nullptr, &locate_fn);
  assert(err == 0);
  err = js_set_named_property(env, exports, "locate", locate_fn);
  assert(err == 0);

  js_value_t *traffic_init_fn;
  err = js_create_function(env, "initTrafficOverlay", -1, init_traffic_overlay, nullptr, &traffic_init_fn);
  assert(err == 0);
  err = js_set_named_property(env, exports, "initTrafficOverlay", traffic_init_fn);
  assert(err == 0);

  js_value_t *traffic_update_fn;
  err = js_create_function(env, "updateTrafficSpeed", -1, update_traffic_speed, nullptr, &traffic_update_fn);
  assert(err == 0);
  err = js_set_named_property(env, exports, "updateTrafficSpeed", traffic_update_fn);
  assert(err == 0);

  return exports;
}

}  // namespace

BARE_MODULE(valhalla_native, valhalla_native_exports)
