import CityModels from "../../models/City.js";
import CountryModels from "../../models/Country.js";
import StateModels from "../../models/State.js";
import {
  getReferencingCounts,
  formatReferenceMessage,
} from "../../utils/referenceHelper.js";

// Helper: Escape regex special characters to prevent NoSQL injection
const escapeRegex = (str = "") =>
  str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// COUNTRY

export const createCountry = async (req, res) => {
  try {
    const { countryName, countryCode, isActive } = req.body;

    const safeCountryName = typeof countryName === "string" ? countryName.trim() : "";

    const existingCountry = await CountryModels.findOne({ countryName: safeCountryName });

    if (existingCountry) {
      return res.status(400).json({
        isOk: false,
        message: "Country already exists",
        status: 400,
      });
    }

    const country = new CountryModels({
      countryName,
      countryCode,
      isActive,
    });
    await country.save();

    return res.status(201).json({
      isOk: true,
      message: "Country created successfully",
      status: 201,
    });
  } catch (error) {
    console.log("Error in createCountry", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listAllCountries = async (req, res) => {
  try {
    const countries = await CountryModels.find({ isActive: true });

    return res.status(200).json({
      isOk: true,
      data: countries,
      status: 200,
    });
  } catch (error) {
    console.log("Error in listAllCountries", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const deleteCountry = async (req, res) => {
  try {
    const { countryId } = req.params;

    const country = await CountryModels.findById(countryId);

    if (!country) {
      return res.status(404).json({
        isOk: false,
        message: "Country not found",
        status: 404,
      });
    }

    const referenceInfo = await getReferencingCounts("Country", countryId);

    if (referenceInfo.totalReferences > 0) {
      return res.status(409).json({
        message: "Cannot delete country. It is being used by other records.",
        isOk: false,
        status: 409,
        totalReferences: referenceInfo.totalReferences,
        references: referenceInfo.details,
        formattedMessage: formatReferenceMessage(referenceInfo.details),
      });
    }

    await CountryModels.findByIdAndDelete({ _id: countryId });

    return res.status(200).json({
      isOk: true,
      message: "Country deleted successfully",
      status: 200,
    });
  } catch (error) {
    console.log("Error in deleteCountry", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const updateCountry = async (req, res) => {
  try {
    const { countryId } = req.params;
    const { countryName, countryCode, isActive } = req.body;

    const country = await CountryModels.findById(countryId);

    if (!country) {
      return res.status(404).json({
        isOk: false,
        message: "Country not found",
        status: 404,
      });
    }

    country.countryName = countryName;
    country.countryCode = countryCode;
    country.isActive = isActive;

    await country.save();

    return res.status(200).json({
      isOk: true,
      message: "Country updated successfully",
      status: 200,
    });
  } catch (error) {
    console.log("Error in updateCountry", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listCountryByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, isActive } = req.body;

    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isInteger(Number(per_page)) ? Number(per_page) : 100;

    let safeIsActive;
    if (isActive === true || isActive === "true") {
      safeIsActive = true;
    } else if (isActive === false || isActive === "false") {
      safeIsActive = false;
    }

    // Build the initial match condition
    let matchCondition = {};
    if (safeIsActive !== undefined) {
      matchCondition.isActive = safeIsActive;
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";

    const pipeline = [
      {
        $sort: {
          [sorton && typeof sorton === "string" ? sorton : "createdAt"]: sortdir === "desc" ? -1 : 1
        }
      },
      ...(safeMatch
        ? [
            {
              $match: {
                $or: [
                  {
                    countryName: {
                      $regex: escapeRegex(safeMatch),
                      $options: "i",
                    },
                  },
                  {
                    countryCode: {
                      $regex: escapeRegex(safeMatch),
                      $options: "i",
                    },
                  },
                ],
              },
            },
          ]
        : []),
      {
        $match: matchCondition,
      },
      {
        $facet: {
          stage1: [
            {
              $group: {
                _id: null,
                count: {
                  $sum: 1,
                },
              },
            },
          ],
          stage2: [
            {
              $skip: safeSkip,
            },
            {
              $limit: safePerPage,
            },
          ],
        },
      },
      {
        $unwind: {
          path: "$stage1",
        },
      },
      {
        $project: {
          count: "$stage1.count",
          data: "$stage2",
        },
      },
    ];

    const list = await CountryModels.aggregate(pipeline);

    return res.status(200).json({
      isOk: true,
      data: list,
      status: 200,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const getCountryById = async (req, res) => {
  try {
    const { countryId } = req.params;

    const country = await CountryModels.findById(countryId);

    if (!country) {
      return res.status(404).json({
        isOk: false,
        message: "Country not found",
        status: 404,
      });
    }

    return res.status(200).json({
      isOk: true,
      data: country,
      status: 200,
    });
  } catch (error) {
    console.log("Error in getCountryById", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

// STATE

export const createState = async (req, res) => {
  try {
    const { stateName, stateCode, countryId, isActive } = req.body;
    

    const safeStateName = typeof stateName === "string" ? stateName.trim() : "";

    const existingState = await StateModels.findOne({ stateName: safeStateName });

    if (existingState) {
      return res.status(400).json({
        isOk: false,
        message: "State already exists",
        status: 400,
      });
    }

    const state = new StateModels({
      stateName,
      stateCode,
      countryId,
      isActive,
    });

    await state.save();

    return res.status(201).json({
      isOk: true,
      message: "State created successfully",
      status: 201,
    });
  } catch (error) {
    console.log("Error in createState", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listAllStates = async (req, res) => {
  try {
    const states = await StateModels.find({ isActive: true }).populate(
      "countryId",
    );

    return res.status(200).json({
      isOk: true,
      data: states,
      status: 200,
    });
  } catch (error) {
    console.log("Error in listAllStates", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const getStateById = async (req, res) => {
  try {
    const { stateId } = req.params;

    const state = await StateModels.findById(stateId);

    if (!state) {
      return res.status(404).json({
        isOk: false,
        message: "State not found",
        status: 404,
      });
    }

    return res.status(200).json({
      isOk: true,
      data: state,
      status: 200,
    });
  } catch (error) {
    console.log("Error in getStateById", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const deleteState = async (req, res) => {
  try {
    const { stateId } = req.params;

    const state = await StateModels.findById(stateId);

    if (!state) {
      return res.status(404).json({
        isOk: false,
        message: "State not found",
        status: 404,
      });
    }

    /**
     * The same guard deleteCountry has carried all along.
     *
     * It was never copied down this file, so deleting a COUNTRY with states
     * under it was refused while deleting one of those states went straight
     * through — orphaning every city beneath it plus every Employee and
     * CompanyMaster address pointing at it. There is no reason for the two to
     * differ.
     */
    const referenceInfo = await getReferencingCounts("State", stateId);

    if (referenceInfo.totalReferences > 0) {
      return res.status(409).json({
        message: "Cannot delete state. It is being used by other records.",
        isOk: false,
        status: 409,
        totalReferences: referenceInfo.totalReferences,
        references: referenceInfo.details,
        formattedMessage: formatReferenceMessage(referenceInfo.details),
      });
    }

    await StateModels.deleteOne({ _id: stateId });

    return res.status(200).json({
      isOk: true,
      message: "State deleted successfully",
      status: 200,
    });
  } catch (error) {
    console.log("Error in deleteState", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const updateState = async (req, res) => {
  try {
    const { stateId } = req.params;
    const { stateName, stateCode, countryId, isActive } = req.body;

    const state = await StateModels.findById(stateId);

    if (!state) {
      return res.status(404).json({
        isOk: false,
        message: "State not found",
        status: 404,
      });
    }

    state.stateName = stateName;
    state.stateCode = stateCode;
    state.countryId = countryId;
    state.isActive = isActive;

    await state.save();

    return res.status(200).json({
      isOk: true,
      message: "State updated successfully",
      status: 200,
    });
  } catch (error) {
    console.log("Error in updateState", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listStateByCountry = async (req, res) => {
  try {
    const { countryId } = req.params;

    const states = await StateModels.find({ countryId, isActive: true });

    return res.status(200).json({
      isOk: true,
      data: states,
      status: 200,
    });
  } catch (error) {
    console.log("Error in listStateByCountry", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listStateByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, isActive } = req.body;

    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isInteger(Number(per_page)) ? Number(per_page) : 100;

    let safeIsActive;
    if (isActive === true || isActive === "true") {
      safeIsActive = true;
    } else if (isActive === false || isActive === "false") {
      safeIsActive = false;
    }

    // Build the initial match condition
    let matchCondition = {};
    if (safeIsActive !== undefined) {
      matchCondition.isActive = safeIsActive;
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";

    const pipeline = [
      {
        $sort: {
          [sorton && typeof sorton === "string" ? sorton : "createdAt"]: sortdir === "desc" ? -1 : 1
        }
      },
      ...(safeMatch
        ? [
            {
              $match: {
                $or: [
                  {
                    stateName: {
                      $regex: escapeRegex(safeMatch),
                      $options: "i",
                    },
                  },
                  {
                    stateCode: {
                      $regex: escapeRegex(safeMatch),
                      $options: "i",
                    },
                  },
                  {
                    countryName: {
                      $regex: escapeRegex(safeMatch),
                      $options: "i",
                    },
                  },
                ],
              },
            },
          ]
        : []),
      {
        $match: matchCondition,
      },
      {
        $lookup: {
          from: "countries",
          localField: "countryId",
          foreignField: "_id",
          as: "country",
        },
      },
      {
        $unwind: {
          path: "$country",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $addFields: {
          countryName: { $ifNull: ["$country.countryName", ""] },
        },
      },
      {
        $facet: {
          stage1: [
            {
              $group: {
                _id: null,
                count: {
                  $sum: 1,
                },
              },
            },
          ],
          stage2: [
            {
              $skip: safeSkip,
            },
            {
              $limit: safePerPage,
            },
          ],
        },
      },
      {
        $unwind: {
          path: "$stage1",
        },
      },
      {
        $project: {
          count: "$stage1.count",
          data: "$stage2",
        },
      },
    ];

    const list = await StateModels.aggregate(pipeline);

    return res.status(200).json({
      isOk: true,
      status: 200,
      data: list,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).status({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

// CITY

export const createCity = async (req, res) => {
  const { cityName, cityCode, stateId, countryId, isActive } = req.body;

  try {
    const safeCityName = typeof cityName === "string" ? cityName.trim() : "";

    const existingCity = await CityModels.findOne({ cityName: safeCityName });

    if (existingCity) {
      return res.status(400).json({
        isOk: false,
        message: "City already exists",
        status: 400,
      });
    }

    const city = new CityModels({
      cityName,
      cityCode,
      stateId,
      countryId,
      isActive,
    });

    await city.save();

    return res.status(201).json({
      isOk: true,
      message: "City created successfully",
      status: 201,
    });
  } catch (error) {
    console.log("Error in createCity", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listAllCities = async (req, res) => {
  try {
    const cities = await CityModels.find({ isActive: true }).populate(
      "stateId countryId",
    );

    return res.status(200).json({
      isOk: true,
      data: cities,
      status: 200,
    });
  } catch (error) {
    console.log("Error in listAllCities", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const getCityById = async (req, res) => {
  try {
    const { cityId } = req.params;

    const city = await CityModels.findById(cityId);

    if (!city) {
      return res.status(404).json({
        isOk: false,
        message: "City not found",
        status: 404,
      });
    }

    return res.status(200).json({
      isOk: true,
      data: city,
      status: 200,
    });
  } catch (error) {
    console.log("Error in getCityById", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const deleteCity = async (req, res) => {
  try {
    const { cityId } = req.params;

    const city = await CityModels.findById(cityId);

    if (!city) {
      return res.status(404).json({
        isOk: false,
        message: "City not found",
        status: 404,
      });
    }

    // As for State and Country above: an Employee or CompanyMaster address
    // pointing here must not be left referencing a city that no longer exists.
    const referenceInfo = await getReferencingCounts("City", cityId);

    if (referenceInfo.totalReferences > 0) {
      return res.status(409).json({
        message: "Cannot delete city. It is being used by other records.",
        isOk: false,
        status: 409,
        totalReferences: referenceInfo.totalReferences,
        references: referenceInfo.details,
        formattedMessage: formatReferenceMessage(referenceInfo.details),
      });
    }

    await CityModels.deleteOne({ _id: cityId });

    return res.status(200).json({
      isOk: true,
      message: "City deleted successfully",
      status: 200,
    });
  } catch (error) {
    console.log("Error in deleteCity", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const updateCity = async (req, res) => {
  try {
    const { cityId } = req.params;
    const { cityName, cityCode, stateId, countryId, isActive } = req.body;

    const city = await CityModels.findById(cityId);

    if (!city) {
      return res.status(404).json({
        isOk: false,
        message: "City not found",
        status: 404,
      });
    }

    city.cityName = cityName;
    city.cityCode = cityCode;
    city.stateId = stateId;
    city.countryId = countryId;
    city.isActive = isActive;

    await city.save();

    return res.status(200).json({
      isOk: true,
      message: "City updated successfully",
      status: 200,
    });
  } catch (error) {
    console.log("Error in updateCity", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listCityByState = async (req, res) => {
  try {
    const { stateId } = req.params;

    const cities = await CityModels.find({ stateId, isActive: true });

    return res.status(200).json({
      isOk: true,
      data: cities,
      status: 200,
    });
  } catch (error) {
    console.log("Error in listCityByState", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

export const listCityByParams = async (req, res) => {
  try {
    let { skip, per_page, sorton, sortdir, match, isActive } = req.body;

    const safeSkip = Number.isInteger(Number(skip)) ? Number(skip) : 0;
    const safePerPage = Number.isInteger(Number(per_page)) ? Number(per_page) : 100;

    let safeIsActive;
    if (isActive === true || isActive === "true") {
      safeIsActive = true;
    } else if (isActive === false || isActive === "false") {
      safeIsActive = false;
    }

    // Build the initial match condition
    let matchCondition = {};
    if (safeIsActive !== undefined) {
      matchCondition.isActive = safeIsActive;
    }

    const safeMatch = typeof match === "string" ? match.trim() : "";

    const pipeline = [
      {
        $sort: {
          [sorton && typeof sorton === "string" ? sorton : "createdAt"]: sortdir === "desc" ? -1 : 1
        }
      },
      ...(safeMatch
        ? [
            {
              $match: {
                $or: [
                  {
                    stateName: {
                      $regex: escapeRegex(safeMatch),
                      $options: "i",
                    },
                  },
                  {
                    countryName: {
                      $regex: escapeRegex(safeMatch),
                      $options: "i",
                    },
                  },
                  {
                    cityName: {
                      $regex: escapeRegex(safeMatch),
                      $options: "i",
                    },
                  },
                ],
              },
            },
          ]
        : []),
      {
        $match: matchCondition,
      },
      {
        $lookup: {
          from: "countries",
          localField: "countryId",
          foreignField: "_id",
          as: "country",
        },
      },
      {
        $unwind: {
          path: "$country",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $addFields: {
          countryName: { $ifNull: ["$country.countryName", ""] },
        },
      },
      {
        $lookup: {
          from: "states",
          localField: "stateId",
          foreignField: "_id",
          as: "state",
        },
      },
      {
        $unwind: {
          path: "$state",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $addFields: {
          stateName: { $ifNull: ["$state.stateName", ""] },
        },
      },
      {
        $facet: {
          stage1: [
            {
              $group: {
                _id: null,
                count: {
                  $sum: 1,
                },
              },
            },
          ],
          stage2: [
            {
              $skip: safeSkip,
            },
            {
              $limit: safePerPage,
            },
          ],
        },
      },
      {
        $unwind: {
          path: "$stage1",
        },
      },
      {
        $project: {
          count: "$stage1.count",
          data: "$stage2",
        },
      },
    ];

    const list = await CityModels.aggregate(pipeline);

    return res.status(200).json({
      isOk: true,
      data: list,
      status: 200,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};

// LOCATION

export const listCountryStateCity = async (req, res) => {
  try {
    const countries = await CountryModels.find({ isActive: true });

    const result = await Promise.all(
      countries.map(async (country) => {
        const states = await StateModels.find({
          countryId: country._id,
          isActive: true,
        });

        const statesWithCities = await Promise.all(
          states.map(async (state) => {
            const cities = await CityModels.find({
              stateId: state._id,
              isActive: true,
            });

            return {
              _id: state._id,
              stateName: state.stateName,
              stateCode: state.stateCode,
              cities: cities.map((city) => ({
                _id: city._id,
                cityName: city.cityName,
                cityCode: city.cityCode,
              })),
            };
          }),
        );

        return {
          _id: country._id,
          countryName: country.countryName,
          countryCode: country.countryCode,
          states: statesWithCities,
        };
      }),
    );

    return res.status(200).json({
      isOk: true,
      data: result,
      status: 200,
    });
  } catch (error) {
    console.log("Error in listCountryStateCity", error);
    return res.status(500).json({
      isOk: false,
      message: error.message,
      status: 500,
    });
  }
};
