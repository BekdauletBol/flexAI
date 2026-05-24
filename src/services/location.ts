import { config } from '../config.js';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
});

interface PlaceResult {
  name: string;
  address: string;
  rating?: number;
  hours?: string[];
  isOpen?: boolean;
  phone?: string;
}

interface WeatherResult {
  temp: number;
  feels_like: number;
  description: string;
  wind_speed: number;
  humidity: number;
  icon: string;
}

interface DirectionsResult {
  duration: string;
  distance: string;
  summary: string;
}

/** Search for a place using Google Places Text Search API */
export async function searchPlace(query: string): Promise<PlaceResult | null> {
  if (!config.googleMapsApiKey) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${config.googleMapsApiKey}`;
    const res = await fetch(url);
    const data = await res.json() as any;
    const place = data.results?.[0];
    if (!place) return null;

    // Get details for hours
    let hours: string[] | undefined;
    let isOpen: boolean | undefined;
    let phone: string | undefined;
    if (place.place_id) {
      const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=opening_hours,formatted_phone_number&key=${config.googleMapsApiKey}`;
      const detailRes = await fetch(detailUrl);
      const details = await detailRes.json() as any;
      hours = details.result?.opening_hours?.weekday_text;
      isOpen = details.result?.opening_hours?.open_now;
      phone = details.result?.formatted_phone_number;
    }

    return {
      name: place.name,
      address: place.formatted_address,
      rating: place.rating,
      hours,
      isOpen,
      phone,
    };
  } catch (err) {
    console.error('[Location] Places search failed:', err);
    return null;
  }
}

/** Get weather forecast for a specific datetime */
export async function getWeatherForecast(lat: number, lng: number, datetime: string): Promise<WeatherResult | null> {
  if (!config.openweatherApiKey) return null;
  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lng}&appid=${config.openweatherApiKey}&units=metric&lang=ru`;
    const res = await fetch(url);
    const data = await res.json() as any;

    const targetTime = new Date(datetime).getTime();
    let closest = data.list?.[0];
    let minDiff = Infinity;

    for (const item of data.list || []) {
      const diff = Math.abs(new Date(item.dt_txt).getTime() - targetTime);
      if (diff < minDiff) { minDiff = diff; closest = item; }
    }

    if (!closest) return null;
    return {
      temp: Math.round(closest.main.temp),
      feels_like: Math.round(closest.main.feels_like),
      description: closest.weather[0]?.description || '',
      wind_speed: closest.wind?.speed || 0,
      humidity: closest.main.humidity,
      icon: closest.weather[0]?.icon || '',
    };
  } catch (err) {
    console.error('[Location] Weather fetch failed:', err);
    return null;
  }
}

/** Get directions from origin to destination */
export async function getDirections(originLat: number, originLng: number, destQuery: string): Promise<DirectionsResult | null> {
  if (!config.googleMapsApiKey) return null;
  try {
    const origin = `${originLat},${originLng}`;
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${encodeURIComponent(destQuery)}&mode=driving&key=${config.googleMapsApiKey}`;
    const res = await fetch(url);
    const data = await res.json() as any;
    const route = data.routes?.[0]?.legs?.[0];
    if (!route) return null;

    return {
      duration: route.duration.text,
      distance: route.distance.text,
      summary: data.routes[0].summary || '',
    };
  } catch (err) {
    console.error('[Location] Directions failed:', err);
    return null;
  }
}

/** Generate a location-based recommendation using GPT-4o */
export async function generateLocationAdvice(
  locationQuery: string,
  visitDatetime: string,
  place: PlaceResult | null,
  weather: WeatherResult | null,
  directions: DirectionsResult | null,
  language: string
): Promise<string> {
  const langMap: Record<string, string> = { ru: 'Russian', en: 'English', kk: 'Kazakh' };
  const lang = langMap[language] || 'Russian';

  const context = [
    `Place: ${locationQuery}`,
    place ? `Found: ${place.name} at ${place.address}, rating: ${place.rating || 'N/A'}, currently ${place.isOpen ? 'OPEN' : 'CLOSED'}` : 'Place not found in Google Maps.',
    place?.hours ? `Hours: ${place.hours.join('; ')}` : '',
    `Visit planned: ${visitDatetime}`,
    weather ? `Weather: ${weather.temp}°C (feels ${weather.feels_like}°C), ${weather.description}, wind ${weather.wind_speed} m/s, humidity ${weather.humidity}%` : '',
    directions ? `Route: ${directions.distance}, ${directions.duration} by car via ${directions.summary}` : '',
  ].filter(Boolean).join('\n');

  try {
    const res = await openai.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: 'system', content: `You give short, practical location advice in ${lang}. Be concise (3-4 sentences max). Include emoji.` },
        { role: 'user', content: `Based on this data, is this a good time to visit? Any issues? Best alternative?\n\n${context}` },
      ],
      temperature: 0.5,
      max_tokens: 300,
    });
    return res.choices[0]?.message?.content || '';
  } catch (err) {
    console.error('[Location] Advice generation failed:', err);
    return '';
  }
}

/** Reverse geocode coordinates to get a city or location name */
export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  if (!config.googleMapsApiKey) return 'My Location';
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${config.googleMapsApiKey}`;
    const res = await fetch(url);
    const data = await res.json() as any;
    const result = data.results?.[0];
    if (!result) return 'My Location';

    // Find city from address components
    for (const comp of result.address_components || []) {
      if (comp.types.includes('locality')) {
        return comp.long_name;
      }
    }
    return result.formatted_address || 'My Location';
  } catch {
    return 'My Location';
  }
}
