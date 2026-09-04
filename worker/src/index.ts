import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  buildDateSearchSegments,
  buildFlightSegments,
  buildTimeRestrictions,
  googleFlightsUrl,
  parseAirlines,
  parseAlliances,
  parseCabinClass,
  parseCurrency,
  parseEmissions,
  parseMaxStops,
  parseSortBy,
  resolveAirport,
  searchAirports,
} from "../../fli-js/src/core/index.ts";

import {
  BagsFilterSchema,
  DateSearchFilters,
  FlightSearchFilters,
  PassengerInfoSchema,
  TripType,
  type FlightResult,
  type FlightLeg,
  type BookingOption,
} from "../../fli-js/src/models/google-flights/index.ts";

import { SearchDates, SearchFlights } from "../../fli-js/src/search/index.ts";

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return jsonResult({
    success: false,
    error: message,
    ...(error instanceof Error && error.stack
      ? { stack: error.stack }
      : {}),
  });
}

function resolveAirports(codes: string) {
  const airports = codes
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => resolveAirport(code));

  if (airports.length === 0) {
    throw new Error(`No valid airport codes found in: '${codes}'`);
  }

  return airports;
}

function airlineCode(airline: unknown): string {
  return String(airline).replace(/^_/, "");
}

function airportCode(airport: unknown): string {
  return String(airport).replace(/^_/, "");
}

function serializeLeg(leg: FlightLeg) {
  return {
    departure_airport: airportCode(leg.departure_airport),
    arrival_airport: airportCode(leg.arrival_airport),
    departure_time: leg.departure_datetime,
    arrival_time: leg.arrival_datetime,
    duration: leg.duration,
    airline: airlineCode(leg.airline),
    airline_code: airlineCode(leg.airline),
    flight_number: leg.flight_number,
    ...(leg.departure_airport_name
      ? { departure_airport_name: leg.departure_airport_name }
      : {}),
    ...(leg.arrival_airport_name
      ? { arrival_airport_name: leg.arrival_airport_name }
      : {}),
    ...(leg.operating_airline
      ? { operating_airline: airlineCode(leg.operating_airline) }
      : {}),
    ...(leg.aircraft ? { aircraft: leg.aircraft } : {}),
    ...(leg.legroom ? { legroom: leg.legroom } : {}),
    ...(leg.overnight ? { overnight: true } : {}),
    ...(leg.amenities ? { amenities: leg.amenities } : {}),
  };
}

function serializeFlight(flight: FlightResult | FlightResult[]) {
  const flights = Array.isArray(flight) ? flight : [flight];

  const legs = flights.flatMap((item) => item.legs);

  const priceFlight =
    flights.length === 2 ? flights[0] : flights[flights.length - 1];

  if (!priceFlight) {
    throw new Error("Flight result is empty");
  }

  return {
    price: priceFlight.price,
    currency: priceFlight.currency ?? "USD",
    legs: legs.map(serializeLeg),
    ...(priceFlight.layovers
      ? {
          layovers: priceFlight.layovers.map((layover) => ({
            airport: airportCode(layover.airport),
            duration: layover.duration,
            ...(layover.overnight ? { overnight: true } : {}),
            ...(layover.change_of_airport
              ? { change_of_airport: true }
              : {}),
          })),
        }
      : {}),
    ...(priceFlight.self_transfer != null
      ? { self_transfer: priceFlight.self_transfer }
      : {}),
    ...(priceFlight.mixed_cabin != null
      ? { mixed_cabin: priceFlight.mixed_cabin }
      : {}),
    ...(priceFlight.primary_airline
      ? { primary_airline: airlineCode(priceFlight.primary_airline) }
      : {}),
    ...(priceFlight.primary_airline_name
      ? { primary_airline_name: priceFlight.primary_airline_name }
      : {}),
  };
}

function flightLegIdentifiers(flight: FlightResult | FlightResult[]) {
  const flights = Array.isArray(flight) ? flight : [flight];

  return flights.flatMap((segment) =>
    segment.legs.map(
      (leg) => `${airlineCode(leg.airline)}${leg.flight_number}`,
    ),
  );
}

function findMatchingFlight(
  flights: Array<FlightResult | FlightResult[]>,
  requested?: string[],
) {
  if (!requested || requested.length === 0) {
    return flights[0] ?? null;
  }

  const wanted = requested.map((item) =>
    item.toUpperCase().replace(/\s/g, ""),
  );

  for (const flight of flights) {
    const identifiers = flightLegIdentifiers(flight).map((item) =>
      item.toUpperCase().replace(/\s/g, ""),
    );

    if (
      identifiers.length === wanted.length &&
      wanted.every((item, index) => {
        const actual = identifiers[index] ?? "";
        const bare = actual.replace(/^[A-Z]+/, "");
        return item === actual || item === bare;
      })
    ) {
      return flight;
    }
  }

  return null;
}

function buildFlightFilters(params: {
  origin: string;
  destination: string;
  departure_date: string;
  return_date?: string;
  departure_window?: string;
  airlines?: string[];
  cabin_class: string;
  max_stops: string;
  sort_by: string;
  passengers: number;
  exclude_basic_economy: boolean;
  emissions: string;
  checked_bags: number;
  carry_on: boolean;
  show_all_results: boolean;
  exclude_airlines?: string[];
  alliance?: string[];
  exclude_alliance?: string[];
  min_layover?: number;
  max_layover?: number;
}) {
  const origins = resolveAirports(params.origin);
  const destinations = resolveAirports(params.destination);

  const timeRestrictions = params.departure_window
    ? buildTimeRestrictions(params.departure_window)
    : null;

  const { segments, tripType } = buildFlightSegments(
    origins,
    destinations,
    params.departure_date,
    params.return_date ?? null,
    timeRestrictions,
  );

  const bags =
    params.checked_bags > 0 || params.carry_on
      ? {
          checked_bags: params.checked_bags,
          carry_on: params.carry_on,
        }
      : null;

  const filters = new FlightSearchFilters({
    trip_type: tripType,
    passenger_info: PassengerInfoSchema.parse({
      adults: params.passengers,
      children: 0,
      infants_in_seat: 0,
      infants_on_lap: 0,
    }),
    flight_segments: segments,
    stops: parseMaxStops(params.max_stops),
    seat_type: parseCabinClass(params.cabin_class),
    airlines: parseAirlines(params.airlines),
    airlines_exclude: parseAirlines(params.exclude_airlines),
    alliances: parseAlliances(params.alliance),
    alliances_exclude: parseAlliances(params.exclude_alliance),
    layover_restrictions:
      params.min_layover != null || params.max_layover != null
        ? {
            min_duration: params.min_layover ?? null,
            max_duration: params.max_layover ?? null,
          }
        : null,
    sort_by: parseSortBy(params.sort_by),
    exclude_basic_economy: params.exclude_basic_economy,
    emissions: parseEmissions(params.emissions),
    bags: bags ? BagsFilterSchema.parse(bags) : null,
    show_all_results: params.show_all_results,
  });

  return {
    filters,
    tripType,
    origins,
    destinations,
  };
}

function serializeBookingOption(option: BookingOption) {
  return {
    ...(option.vendor_name ? { vendor_name: option.vendor_name } : {}),
    ...(option.vendor_code ? { vendor_code: option.vendor_code } : {}),
    ...(option.fare_name ? { fare_name: option.fare_name } : {}),
    ...(option.price != null ? { price: option.price } : {}),
    ...(option.currency ? { currency: option.currency } : {}),
    ...(option.booking_url ? { booking_url: option.booking_url } : {}),
    ...(option.google_click_url
      ? { google_click_url: option.google_click_url }
      : {}),
    ...(option.is_airline_direct
      ? { is_airline_direct: true }
      : {}),
  };
}

function createServer() {
  const server = new McpServer({
    name: "FLI Flight Search MCP",
    version: "0.1.0",
  });

  // ---------------------------------------------------------------------------
  // 1. search_flights
  // ---------------------------------------------------------------------------

  server.registerTool(
    "search_flights",
    {
      description:
        "Search for flights between airports on a specific date. Supports one-way and round-trip searches with airline, cabin, stop, time, baggage, alliance and locale filters.",
      inputSchema: {
        origin: z
          .string()
          .describe(
            "Departure airport IATA code(s), comma-separated, e.g. JFK or JFK,LGA",
          ),
        destination: z
          .string()
          .describe(
            "Arrival airport IATA code(s), comma-separated, e.g. LHR or LHR,CDG",
          ),
        departure_date: z
          .string()
          .describe("Travel date in YYYY-MM-DD format"),
        return_date: z
          .string()
          .optional()
          .describe("Return date in YYYY-MM-DD format; omit for one-way"),
        departure_window: z
          .string()
          .optional()
          .describe("Departure time window such as 6-20"),
        airlines: z
          .array(z.string())
          .optional()
          .describe("Airline IATA codes to include"),
        cabin_class: z
          .string()
          .default("ECONOMY")
          .describe("ECONOMY, PREMIUM_ECONOMY, BUSINESS, or FIRST"),
        max_stops: z
          .string()
          .default("ANY")
          .describe("ANY, NON_STOP, ONE_STOP, TWO_PLUS_STOPS"),
        sort_by: z
          .string()
          .default("CHEAPEST")
          .describe(
            "TOP_FLIGHTS, BEST, CHEAPEST, DEPARTURE_TIME, ARRIVAL_TIME, DURATION, EMISSIONS",
          ),
        passengers: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("Number of adult passengers"),
        exclude_basic_economy: z
          .boolean()
          .default(false),
        emissions: z
          .string()
          .default("ALL")
          .describe("ALL or LESS"),
        checked_bags: z
          .number()
          .int()
          .min(0)
          .max(2)
          .default(0),
        carry_on: z.boolean().default(false),
        show_all_results: z.boolean().default(true),
        currency: z.string().optional(),
        language: z.string().optional(),
        country: z.string().optional(),
        exclude_airlines: z.array(z.string()).optional(),
        alliance: z.array(z.string()).optional(),
        exclude_alliance: z.array(z.string()).optional(),
        min_layover: z.number().int().min(1).optional(),
        max_layover: z.number().int().min(1).optional(),
      },
    },
    async (params) => {
      try {
        const {
          filters,
          tripType,
          origins,
          destinations,
        } = buildFlightFilters(params);

        const currency = parseCurrency(params.currency);

        const search = new SearchFlights();

        const flights = await search.search(filters, {
          currency,
          language: params.language ?? null,
          country: params.country ?? null,
          topN: 5,
        });

        const bookingUrl = googleFlightsUrl(
          airportCode(origins[0]),
          airportCode(destinations[0]),
          params.departure_date,
          params.return_date ?? null,
          params.currency ?? null,
          params.language ?? null,
          params.country ?? null,
        );

        if (!flights) {
          return jsonResult({
            success: true,
            flights: [],
            count: 0,
            trip_type: tripType === TripType.ROUND_TRIP
              ? "ROUND_TRIP"
              : "ONE_WAY",
            booking_url: bookingUrl,
          });
        }

        const flightResults = flights.map((flight) => ({
          ...serializeFlight(flight),
          booking_url: search.buildFlightBookingUrl(flight, {
            currency: params.currency ?? null,
            language: params.language ?? null,
            country: params.country ?? null,
          }),
        }));

        return jsonResult({
          success: true,
          flights: flightResults,
          count: flightResults.length,
          trip_type:
            tripType === TripType.ROUND_TRIP
              ? "ROUND_TRIP"
              : "ONE_WAY",
          booking_url: bookingUrl,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // 2. search_dates
  // ---------------------------------------------------------------------------

  server.registerTool(
    "search_dates",
    {
      description:
        "Find the cheapest travel dates between two airports within a date range.",
      inputSchema: {
        origin: z.string().describe("Departure airport IATA code"),
        destination: z.string().describe("Arrival airport IATA code"),
        start_date: z
          .string()
          .describe("Start date in YYYY-MM-DD format"),
        end_date: z
          .string()
          .describe("End date in YYYY-MM-DD format"),
        trip_duration: z
          .number()
          .int()
          .min(1)
          .default(3)
          .describe("Trip duration in days for round trips"),
        is_round_trip: z.boolean().default(false),
        airlines: z.array(z.string()).optional(),
        cabin_class: z.string().default("ECONOMY"),
        max_stops: z.string().default("ANY"),
        departure_window: z.string().optional(),
        sort_by_price: z.boolean().default(false),
        passengers: z.number().int().min(1).default(1),
        currency: z.string().optional(),
        language: z.string().optional(),
        country: z.string().optional(),
        exclude_airlines: z.array(z.string()).optional(),
        alliance: z.array(z.string()).optional(),
        exclude_alliance: z.array(z.string()).optional(),
        min_layover: z.number().int().min(1).optional(),
        max_layover: z.number().int().min(1).optional(),
      },
    },
    async (params) => {
      try {
        const origins = resolveAirports(params.origin);
        const destinations = resolveAirports(params.destination);

        const timeRestrictions = params.departure_window
          ? buildTimeRestrictions(params.departure_window)
          : null;

        const {
          segments,
          tripType,
        } = buildDateSearchSegments(
          origins,
          destinations,
          params.start_date,
          {
            tripDuration: params.trip_duration,
            isRoundTrip: params.is_round_trip,
            timeRestrictions,
          },
        );

        const filters = new DateSearchFilters({
          trip_type: tripType,
          passenger_info: PassengerInfoSchema.parse({
            adults: params.passengers,
            children: 0,
            infants_in_seat: 0,
            infants_on_lap: 0,
          }),
          flight_segments: segments,
          stops: parseMaxStops(params.max_stops),
          seat_type: parseCabinClass(params.cabin_class),
          airlines: parseAirlines(params.airlines),
          airlines_exclude: parseAirlines(params.exclude_airlines),
          alliances: parseAlliances(params.alliance),
          alliances_exclude: parseAlliances(params.exclude_alliance),
          layover_restrictions:
            params.min_layover != null || params.max_layover != null
              ? {
                  min_duration: params.min_layover ?? null,
                  max_duration: params.max_layover ?? null,
                }
              : null,
          from_date: params.start_date,
          to_date: params.end_date,
          duration: params.is_round_trip
            ? params.trip_duration
            : null,
        });

        const currency = parseCurrency(params.currency);

        const search = new SearchDates();

        const dates = await search.search(filters, {
          currency,
          language: params.language ?? null,
          country: params.country ?? null,
        });

        if (!dates) {
          return jsonResult({
            success: true,
            dates: [],
            count: 0,
            trip_type:
              tripType === TripType.ROUND_TRIP
                ? "ROUND_TRIP"
                : "ONE_WAY",
            date_range: `${params.start_date} to ${params.end_date}`,
          });
        }

        if (params.sort_by_price) {
          dates.sort((a, b) => a.price - b.price);
        }

        const dateResults = dates.map((item) => {
          const departure = item.date[0]
            ?.toISOString()
            .slice(0, 10);

          const returnDate =
            item.date.length > 1
              ? item.date[1]?.toISOString().slice(0, 10)
              : null;

          return {
            date: departure,
            price: item.price,
            currency: item.currency ?? params.currency ?? "USD",
            return_date: returnDate,
            ...(departure
              ? {
                  booking_url: googleFlightsUrl(
                    airportCode(origins[0]),
                    airportCode(destinations[0]),
                    departure,
                    returnDate,
                    params.currency ?? null,
                    params.language ?? null,
                    params.country ?? null,
                  ),
                }
              : {}),
          };
        });

        return jsonResult({
          success: true,
          dates: dateResults,
          count: dateResults.length,
          trip_type:
            tripType === TripType.ROUND_TRIP
              ? "ROUND_TRIP"
              : "ONE_WAY",
          date_range: `${params.start_date} to ${params.end_date}`,
          duration: params.is_round_trip
            ? params.trip_duration
            : null,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // 3. get_booking_options
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get_booking_options",
    {
      description:
        "Get bookable fares and direct booking URLs for a flight. Use flight numbers from a previous search_flights result.",
      inputSchema: {
        origin: z.string(),
        destination: z.string(),
        departure_date: z.string(),
        flight_numbers: z
          .array(z.string())
          .optional()
          .describe(
            "Flight numbers such as ['BA178']; omit to select the top result",
          ),
        return_date: z.string().optional(),
        cabin_class: z.string().default("ECONOMY"),
        max_stops: z.string().default("ANY"),
        passengers: z.number().int().min(1).default(1),
        airlines: z.array(z.string()).optional(),
        exclude_basic_economy: z.boolean().default(false),
        currency: z.string().optional(),
        language: z.string().optional(),
        country: z.string().optional(),
        departure_window: z.string().optional(),
        sort_by: z.string().default("CHEAPEST"),
        exclude_airlines: z.array(z.string()).optional(),
        alliance: z.array(z.string()).optional(),
        exclude_alliance: z.array(z.string()).optional(),
        min_layover: z.number().int().min(1).optional(),
        max_layover: z.number().int().min(1).optional(),
        emissions: z.string().default("ALL"),
        checked_bags: z.number().int().min(0).max(2).default(0),
        carry_on: z.boolean().default(false),
      },
    },
    async (params) => {
      try {
        const {
          filters,
          tripType,
          origins,
          destinations,
        } = buildFlightFilters({
          ...params,
          show_all_results: true,
        });

        const currency = parseCurrency(params.currency);

        const search = new SearchFlights();

        const flights = await search.search(filters, {
          currency,
          language: params.language ?? null,
          country: params.country ?? null,
          topN: 5,
        });

        const bookingUrl = googleFlightsUrl(
          airportCode(origins[0]),
          airportCode(destinations[0]),
          params.departure_date,
          params.return_date ?? null,
          params.currency ?? null,
          params.language ?? null,
          params.country ?? null,
        );

        if (!flights || flights.length === 0) {
          return jsonResult({
            success: true,
            options: [],
            count: 0,
            booking_url: bookingUrl,
          });
        }

        const selected = findMatchingFlight(
          flights,
          params.flight_numbers,
        );

        if (!selected) {
          return jsonResult({
            success: false,
            error:
              "No flight matched the requested flight_numbers. Pass values from a prior search_flights result.",
            available_flights: flights
              .slice(0, 20)
              .map(flightLegIdentifiers),
            options: [],
            booking_url: bookingUrl,
          });
        }

        const options = await search.getBookingOptions(
          selected,
          filters,
          {
            currency,
            language: params.language ?? null,
            country: params.country ?? null,
          },
        );

        const flightBookingUrl = search.buildFlightBookingUrl(
          selected,
          {
            currency: params.currency ?? null,
            language: params.language ?? null,
            country: params.country ?? null,
          },
        );

        const serialized = options.map(serializeBookingOption);

        const result: Record<string, unknown> = {
          success: true,
          selected_flight: {
            ...serializeFlight(selected),
            booking_url: flightBookingUrl,
          },
          options: serialized,
          count: serialized.length,
          booking_url: bookingUrl,
        };

        if (serialized.length === 0) {
          result.note =
            "Google returned no per-vendor booking fares. Use selected_flight.booking_url to open the specific flight on Google Flights.";
        }

        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // 4. find_airports
  // ---------------------------------------------------------------------------

  server.registerTool(
    "find_airports",
    {
      description:
        "Search airports by city name, airport name, or IATA code.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "City, airport name, or IATA code, e.g. new york, heathrow, JFK",
          ),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, limit }) => {
      try {
        const results = searchAirports(query, limit);

        return jsonResult({
          success: true,
          query,
          count: results.length,
          airports: results.map((result) => ({
            code: airportCode(result.code),
            name: result.name,
            match_type: result.match_type,
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    return createMcpHandler(createServer)(request, env, ctx);
  },
} satisfies ExportedHandler;
